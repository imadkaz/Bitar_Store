import { Prisma, PrismaClient } from '../generated/prisma/client';
import { centsOf } from '../mapper/Sale.Mapper';
import { AdjustableBucket, AdjustmentRequest, PlannedMove } from '../models/Adjustment.model';
import { compareStockBuckets } from '../models/StockBucket';
import { ConflictError } from '../utils/exeptions/ConflictError';
import { AuditInput, writeAudit } from './audit';
import { claimIdempotencyKey, completeIdempotencyKey } from './idempotency';
import { AdjustmentTransaction, IAdjustmentUnitOfWork } from './interfaces/IAdjustmentUnitOfWork';
import { IdempotencyClaim, SkuForSale } from './interfaces/ISalesUnitOfWork';

class PrismaAdjustmentTransaction implements AdjustmentTransaction {
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

    async placeExists(branchId: string): Promise<{ code: string } | null> {
        const row = await this.tx.branch.findUnique({ where: { id: branchId }, select: { code: true } });
        return row;
    }

    async lockBalances(branchId: string, skuId: string, buckets: AdjustableBucket[]): Promise<Map<AdjustableBucket, number>> {
        const quantities = new Map<AdjustableBucket, number>(buckets.map((b) => [b, 0]));
        const rows = await this.tx.$queryRaw<{ bucket: AdjustableBucket; quantity: number }[]>`
            SELECT bucket, quantity FROM stock_balances
            WHERE branch_id = ${branchId}::uuid AND sku_id = ${skuId}::uuid AND bucket IN (${Prisma.join(buckets)})
            ORDER BY CASE bucket WHEN 'sellable' THEN 0 WHEN 'non_sellable' THEN 1 END
            FOR UPDATE`;
        for (const row of rows) quantities.set(row.bucket, row.quantity);
        return quantities;
    }

    async insertAdjustment(request: AdjustmentRequest, actorId: string, idempotencyKeyId: string): Promise<{ id: string; reference: string }> {
        const row = await this.tx.adjustment.create({
            data: { branchId: request.branchId, skuId: request.skuId, bucket: request.bucket, quantityDelta: request.quantityDelta, reason: request.reason, note: request.note, adjustedBy: actorId, idempotencyKeyId },
        });
        return { id: row.id, reference: row.reference };
    }

    async applyMoves(adjustmentId: string, request: AdjustmentRequest, moves: PlannedMove[], actorId: string, idempotencyKeyId: string): Promise<void> {
        for (const move of [...moves].sort((a, b) => compareStockBuckets(a.bucket, b.bucket))) {
            let rows: { quantity: number }[];
            if (move.delta > 0) {
                rows = await this.tx.$queryRaw<{ quantity: number }[]>`
                    INSERT INTO stock_balances (sku_id, branch_id, bucket, quantity)
                    VALUES (${request.skuId}::uuid, ${request.branchId}::uuid, ${move.bucket}, ${move.delta})
                    ON CONFLICT (sku_id, branch_id, bucket) DO UPDATE SET quantity = stock_balances.quantity + EXCLUDED.quantity
                    RETURNING quantity`;
            } else {
                rows = await this.tx.$queryRaw<{ quantity: number }[]>`
                    UPDATE stock_balances SET quantity = quantity + ${move.delta}
                    WHERE sku_id = ${request.skuId}::uuid AND branch_id = ${request.branchId}::uuid AND bucket = ${move.bucket}
                    RETURNING quantity`;
                if (rows.length === 0) throw new ConflictError('The stock to take out of this place is not there');
            }
            await this.tx.stockMovement.create({
                data: {
                    skuId: request.skuId, branchId: request.branchId, bucket: move.bucket, movementType: 'adjustment', quantityDelta: move.delta, balanceAfter: rows[0].quantity,
                    adjustmentId, reason: request.reason, actorUserId: actorId, idempotencyKeyId,
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

export class AdjustmentUnitOfWork implements IAdjustmentUnitOfWork {
    constructor(private readonly prisma: PrismaClient) {}

    run<T>(work: (tx: AdjustmentTransaction) => Promise<T>): Promise<T> {
        return this.prisma.$transaction((tx) => work(new PrismaAdjustmentTransaction(tx)), { maxWait: 10_000, timeout: 30_000 });
    }
}
