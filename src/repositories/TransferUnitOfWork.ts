import { Prisma, PrismaClient } from '../generated/prisma/client';
import { centsOf } from '../mapper/Sale.Mapper';
import { StockBucket, StockMove, Transfer, TransferStatus } from '../models/Transfer.model';
import { ConflictError } from '../utils/exeptions/ConflictError';
import { AuditInput, writeAudit } from './audit';
import { claimIdempotencyKey, completeIdempotencyKey } from './idempotency';
import { IdempotencyClaim, SkuForSale } from './interfaces/ISalesUnitOfWork';
import { ITransferUnitOfWork, PlaceInfo, TransferTransaction } from './interfaces/ITransferUnitOfWork';

class PrismaTransferTransaction implements TransferTransaction {
    constructor(private readonly tx: Prisma.TransactionClient) {}

    claimIdempotencyKey(userId: string, operation: string, key: string, requestHash: string): Promise<IdempotencyClaim> {
        return claimIdempotencyKey(this.tx, userId, operation, key, requestHash);
    }

    async findSkus(skuIds: string[]): Promise<SkuForSale[]> {
        const rows = await this.tx.sku.findMany({ where: { id: { in: skuIds } }, include: { style: true } });
        return rows.map((row) => ({
            skuId: row.id, skuCode: row.skuCode, styleName: row.style.name, priceCents: centsOf(row.standardPrice), currency: row.currency,
            skuActive: row.isActive, styleActive: row.style.isActive,
        }));
    }

    async findPlace(id: string): Promise<PlaceInfo | null> {
        const row = await this.tx.branch.findUnique({ where: { id } });
        return row ? { id: row.id, code: row.code, name: row.name, isActive: row.isActive, isWarehouse: row.kind === 'warehouse' } : null;
    }

    async insertTransfer(transfer: Transfer, actorId: string): Promise<void> {
        await this.tx.transfer.create({
            data: {
                id: transfer.id,
                sourceBranchId: transfer.sourceBranchId,
                destinationBranchId: transfer.destinationBranchId,
                status: 'draft',
                requestedBy: actorId,
                note: transfer.note,
                createdBy: actorId,
                updatedBy: actorId,
                lines: { create: transfer.getLines().map((l) => ({ skuId: l.skuId, requestedQty: l.requestedQty })) },
            },
        });
    }

    async lockTransfer(id: string): Promise<Transfer | null> {
        await this.tx.$queryRaw`SELECT id FROM transfers WHERE id = ${id}::uuid FOR UPDATE`;
        const row = await this.tx.transfer.findUnique({ where: { id }, include: { lines: true } });
        if (!row) return null;
        return Transfer.restore({
            id: row.id, reference: row.reference, sourceBranchId: row.sourceBranchId, destinationBranchId: row.destinationBranchId, status: row.status as TransferStatus,
            note: row.note, requestedBy: row.requestedBy,
            lines: row.lines.map((l) => ({
                skuId: l.skuId,
                requestedQty: l.requestedQty,
                dispatchedQty: l.dispatchedQty,
                receivedQty: l.receivedQty,
                damagedQty: l.damagedQty,
                releasedQty: l.releasedQty,
                resolvedQty: l.resolvedQty,
            })),
        });
    }

    async lockStock(branchId: string, skuIds: string[], bucket: StockBucket): Promise<Map<string, number>> {
        const quantities = new Map<string, number>(skuIds.map((id) => [id, 0]));
        if (skuIds.length === 0) return quantities;
        const ids = Prisma.join(skuIds.map((id) => Prisma.sql`${id}::uuid`));
        const rows = await this.tx.$queryRaw<{ sku_id: string; quantity: number }[]>(Prisma.sql`
            SELECT sku_id, quantity FROM stock_balances
            WHERE branch_id = ${branchId}::uuid AND bucket = ${bucket} AND sku_id IN (${ids})
            ORDER BY sku_id
            FOR UPDATE`);
        for (const row of rows) quantities.set(row.sku_id, row.quantity);
        return quantities;
    }

    async applyMoves(transferId: string, moves: StockMove[], actorId: string, idempotencyKeyId: string): Promise<void> {
        // always in the same order (place, sku, bucket): two transfers touching the same balances never wait for each other in a circle
        const ordered = [...moves].sort((a, b) => a.branchId.localeCompare(b.branchId) || a.skuId.localeCompare(b.skuId) || a.bucket.localeCompare(b.bucket));
        for (const move of ordered) {
            let rows: { quantity: number }[];
            if (move.delta > 0) {
                // adds to the balance, or creates it the first time this sku reaches this place
                rows = await this.tx.$queryRaw<{ quantity: number }[]>`
                    INSERT INTO stock_balances (sku_id, branch_id, bucket, quantity)
                    VALUES (${move.skuId}::uuid, ${move.branchId}::uuid, ${move.bucket}, ${move.delta})
                    ON CONFLICT (sku_id, branch_id, bucket) DO UPDATE SET quantity = stock_balances.quantity + EXCLUDED.quantity
                    RETURNING quantity`;
            } else {
                // takes from a balance that must already be there (the CHECK quantity >= 0 is the last guard)
                rows = await this.tx.$queryRaw<{ quantity: number }[]>`
                    UPDATE stock_balances SET quantity = quantity + ${move.delta}
                    WHERE sku_id = ${move.skuId}::uuid AND branch_id = ${move.branchId}::uuid AND bucket = ${move.bucket}
                    RETURNING quantity`;
                if (rows.length === 0) throw new ConflictError('The stock to take out of this place is not there');
            }
            await this.tx.stockMovement.create({
                data: {
                    skuId: move.skuId, branchId: move.branchId, bucket: move.bucket, movementType: move.type, quantityDelta: move.delta, balanceAfter: rows[0].quantity,
                    transferId, reason: move.reason ?? null, actorUserId: actorId, idempotencyKeyId,
                },
            });
        }
    }

    async saveTransfer(transfer: Transfer, actorId: string, dispatched?: { by: string; at: Date }): Promise<void> {
        await this.tx.transfer.update({
            where: { id: transfer.id },
            data: { status: transfer.getStatus(), updatedBy: actorId, ...(dispatched ? { dispatchedBy: dispatched.by, dispatchedAt: dispatched.at } : {}) },
        });
        for (const line of transfer.getLines()) {
            await this.tx.transferLine.update({
                where: { transferId_skuId: { transferId: transfer.id, skuId: line.skuId } },
                data: {
                    dispatchedQty: line.dispatchedQty,
                    receivedQty: line.receivedQty,
                    damagedQty: line.damagedQty,
                    releasedQty: line.releasedQty,
                    resolvedQty: line.resolvedQty,
                },
            });
        }
    }

    audit(event: AuditInput): Promise<void> {
        return writeAudit(this.tx, event);
    }

    completeIdempotencyKey(idempotencyKeyId: string, resourceType: string, resourceId: string): Promise<void> {
        return completeIdempotencyKey(this.tx, idempotencyKeyId, resourceType, resourceId);
    }
}

export class TransferUnitOfWork implements ITransferUnitOfWork {
    constructor(private readonly prisma: PrismaClient) {}

    run<T>(work: (tx: TransferTransaction) => Promise<T>): Promise<T> {
        return this.prisma.$transaction((tx) => work(new PrismaTransferTransaction(tx)), { maxWait: 10_000, timeout: 30_000 });
    }
}
