import { Prisma, PrismaClient } from '../generated/prisma/client';
import { centsOf } from '../mapper/Sale.Mapper';
import { GoodsReceiptLineRequest, GoodsReceiptRequest } from '../models/GoodsReceipt.model';
import { formatCents } from '../models/Money';
import { NotFoundError } from '../utils/exeptions/NotFoundError';
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

    async resolveSupplier(request: GoodsReceiptRequest, canCreate: boolean, actorId: string): Promise<{ id: string; name: string }> {
        const found = request.supplierId
            ? await this.tx.$queryRaw<{ id: string; name: string; is_active: boolean }[]>`SELECT id, name, is_active FROM suppliers WHERE id = ${request.supplierId}::uuid`
            : await this.tx.$queryRaw<{ id: string; name: string; is_active: boolean }[]>`SELECT id, name, is_active FROM suppliers WHERE lower(name) = lower(${request.supplierName})`;
        if (found.length > 0) {
            if (!found[0].is_active) throw new ConflictError(`The supplier ${found[0].name} is inactive: a manager has to switch it on first`);
            return { id: found[0].id, name: found[0].name };
        }
        if (request.supplierId) throw new NotFoundError('Supplier not found');
        if (!canCreate) throw new ConflictError(`The supplier ${request.supplierName} does not exist yet: a manager has to add it under Suppliers`);
        // several deliveries naming the same new supplier at the same moment: one adds it, the others find it (no error, no duplicate)
        const inserted = await this.tx.$queryRaw<{ id: string; name: string }[]>`
            INSERT INTO suppliers (name, created_by, updated_by) VALUES (${request.supplierName}, ${actorId}::uuid, ${actorId}::uuid)
            ON CONFLICT ((lower(name))) DO NOTHING RETURNING id, name`;
        if (inserted.length > 0) {
            await writeAudit(this.tx, { actorId, action: 'supplier.create', entityType: 'supplier', entityId: inserted[0].id, details: { name: inserted[0].name, from: 'goods receipt' } });
            return inserted[0];
        }
        const existing = await this.tx.$queryRaw<{ id: string; name: string; is_active: boolean }[]>`SELECT id, name, is_active FROM suppliers WHERE lower(name) = lower(${request.supplierName})`;
        if (!existing[0].is_active) throw new ConflictError(`The supplier ${existing[0].name} is inactive: a manager has to switch it on first`);
        return { id: existing[0].id, name: existing[0].name };
    }

    async findDuplicate(supplierId: string, supplierInvoiceNumber: string): Promise<{ id: string; reference: string } | null> {
        const rows = await this.tx.$queryRaw<{ id: string; reference: string }[]>`
            SELECT id, reference FROM goods_receipts
            WHERE supplier_id = ${supplierId}::uuid AND lower(supplier_invoice_number) = lower(${supplierInvoiceNumber})`;
        return rows[0] ?? null;
    }

    async insertReceipt(request: GoodsReceiptRequest, supplier: { id: string; name: string }, totalCents: number, warehouseId: string, actorId: string, idempotencyKeyId: string): Promise<{ id: string; reference: string }> {
        const row = await this.tx.goodsReceipt.create({
            data: {
                branchId: warehouseId, supplierId: supplier.id, supplierName: supplier.name, supplierInvoiceNumber: request.supplierInvoiceNumber, invoiceDate: new Date(`${request.invoiceDate}T00:00:00Z`),
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
            // the weighted average cost: (what was there x its cost + what came x its cost) / the whole. The stock row is locked by the upsert above,
            // so two deliveries of the same product never compute from the same old quantity.
            const onHand = await this.tx.$queryRaw<{ before: number }[]>`
                SELECT COALESCE(SUM(quantity), 0)::int - ${line.quantity} AS before FROM stock_balances
                WHERE sku_id = ${line.skuId}::uuid AND branch_id = ${warehouseId}::uuid AND bucket IN ('sellable', 'non_sellable')`;
            const unitCost = formatCents(line.unitCostCents);
            const before = onHand[0].before;
            await this.tx.$executeRaw`
                INSERT INTO stock_costs (sku_id, branch_id, avg_unit_cost, updated_at) VALUES (${line.skuId}::uuid, ${warehouseId}::uuid, ${unitCost}::numeric, now())
                ON CONFLICT (sku_id, branch_id) DO UPDATE SET updated_at = now(), avg_unit_cost = CASE
                    WHEN stock_costs.avg_unit_cost IS NULL OR ${before}::int <= 0 THEN EXCLUDED.avg_unit_cost
                    ELSE round((stock_costs.avg_unit_cost * ${before}::int + EXCLUDED.avg_unit_cost * ${line.quantity}::int) / (${before}::int + ${line.quantity}::int), 4) END`;
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
