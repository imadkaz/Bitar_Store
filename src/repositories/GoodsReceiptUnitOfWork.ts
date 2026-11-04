import { Prisma, PrismaClient } from '../generated/prisma/client';
import { centsOf } from '../mapper/Sale.Mapper';
import { GoodsReceiptLineRequest, GoodsReceiptRequest } from '../models/GoodsReceipt.model';
import { formatCents } from '../models/Money';
import { ConflictError } from '../utils/exeptions/ConflictError';
import { AuditInput, writeAudit } from './audit';
import { claimIdempotencyKey, completeIdempotencyKey } from './idempotency';
import { GoodsReceiptTransaction, IGoodsReceiptUnitOfWork } from './interfaces/IGoodsReceiptUnitOfWork';
import { IdempotencyClaim, SkuForSale } from './interfaces/ISalesUnitOfWork';

class PrismaGoodsReceiptTransaction implements GoodsReceiptTransaction {
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

    async findDuplicate(supplierName: string, supplierInvoiceNumber: string): Promise<{ id: string; reference: string } | null> {
        const rows = await this.tx.$queryRaw<{ id: string; reference: string }[]>`
            SELECT id, reference FROM goods_receipts
            WHERE lower(supplier_name) = lower(${supplierName}) AND lower(supplier_invoice_number) = lower(${supplierInvoiceNumber})`;
        return rows[0] ?? null;
    }

    async insertReceipt(request: GoodsReceiptRequest, totalCents: number, warehouseId: string, actorId: string, idempotencyKeyId: string): Promise<{ id: string; reference: string }> {
        const row = await this.tx.goodsReceipt.create({
            data: {
                branchId: warehouseId, supplierName: request.supplierName, supplierInvoiceNumber: request.supplierInvoiceNumber, invoiceDate: new Date(`${request.invoiceDate}T00:00:00Z`),
                currency: request.currency, note: request.note, totalCost: formatCents(totalCents), receivedBy: actorId, idempotencyKeyId,
                lines: { create: request.lines.map((l) => ({ skuId: l.skuId, quantity: l.quantity, unitCost: formatCents(l.unitCostCents) })) },
            },
        });
        return { id: row.id, reference: row.reference };
    }

    async applyReceipt(receiptId: string, warehouseId: string, lines: GoodsReceiptLineRequest[], actorId: string, idempotencyKeyId: string): Promise<void> {
        for (const line of [...lines].sort((a, b) => a.skuId.localeCompare(b.skuId))) {          // always the same order: two receipts never wait on each other in a circle
            const rows = await this.tx.$queryRaw<{ quantity: number }[]>`
                INSERT INTO stock_balances (sku_id, branch_id, bucket, quantity)
                VALUES (${line.skuId}::uuid, ${warehouseId}::uuid, 'sellable', ${line.quantity})
                ON CONFLICT (sku_id, branch_id, bucket) DO UPDATE SET quantity = stock_balances.quantity + EXCLUDED.quantity
                RETURNING quantity`;
            await this.tx.stockMovement.create({
                data: {
                    skuId: line.skuId, branchId: warehouseId, bucket: 'sellable', movementType: 'goods_receipt', quantityDelta: line.quantity, balanceAfter: rows[0].quantity,
                    goodsReceiptId: receiptId, reason: 'supplier delivery', actorUserId: actorId, idempotencyKeyId,
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

export class GoodsReceiptUnitOfWork implements IGoodsReceiptUnitOfWork {
    constructor(private readonly prisma: PrismaClient) {}

    async run<T>(work: (tx: GoodsReceiptTransaction) => Promise<T>): Promise<T> {
        try {
            return await this.prisma.$transaction((tx) => work(new PrismaGoodsReceiptTransaction(tx)), { maxWait: 10_000, timeout: 30_000 });
        } catch (error) {
            // two people entering the same supplier invoice at the same moment: the database lets only one in
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002' && JSON.stringify(error.meta ?? {}).includes('supplier_invoice')) {
                throw new ConflictError('This supplier invoice was already received');
            }
            throw error;
        }
    }
}
