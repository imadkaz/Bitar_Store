import { Prisma, PrismaClient } from '../generated/prisma/client';
import { centsOf, SaleMapper } from '../mapper/Sale.Mapper';
import { Sale } from '../models/Sale.model';
import { ConflictError } from '../utils/exeptions/ConflictError';
import { claimIdempotencyKey, completeIdempotencyKey } from './idempotency';
import { IdempotencyClaim, ISalesUnitOfWork, SaleTransaction, SkuForSale } from './interfaces/ISalesUnitOfWork';

class PrismaSaleTransaction implements SaleTransaction {
    constructor(private readonly tx: Prisma.TransactionClient) {}

    claimIdempotencyKey(userId: string, operation: string, key: string, requestHash: string): Promise<IdempotencyClaim> {
        return claimIdempotencyKey(this.tx, userId, operation, key, requestHash);
    }

    async findSkusForSale(skuIds: string[]): Promise<SkuForSale[]> {
        const rows = await this.tx.sku.findMany({ where: { id: { in: skuIds } }, include: { style: true } });
        return rows.map((row) => ({
            skuId: row.id,
            skuCode: row.skuCode,
            styleName: row.style.name,
            priceCents: centsOf(row.standardPrice),
            currency: row.currency,
            skuActive: row.isActive,
            styleActive: row.style.isActive,
        }));
    }

    // FOR UPDATE: any other sale of the same sku at this branch WAITS here until we commit or roll back.
    // Rows are locked in sku order (ORDER BY), so two sales with several skus can never wait on each other in a circle.
    async lockSellableStock(branchId: string, skuIds: string[]): Promise<Map<string, number>> {
        const ids = Prisma.join(skuIds.map((id) => Prisma.sql`${id}::uuid`));
        const rows = await this.tx.$queryRaw<{ sku_id: string; quantity: number }[]>(Prisma.sql`
            SELECT sku_id, quantity FROM stock_balances
            WHERE branch_id = ${branchId}::uuid AND bucket = 'sellable' AND sku_id IN (${ids})
            ORDER BY sku_id
            FOR UPDATE`);
        const quantities = new Map<string, number>(skuIds.map((id) => [id, 0]));
        for (const row of rows) quantities.set(row.sku_id, row.quantity);
        return quantities;
    }

    async resolveCashSession(branchId: string): Promise<string | null> {
        const setting = await this.tx.$queryRaw<{ value: unknown }[]>`SELECT value FROM settings WHERE key = 'requireOpenCashSession'`;
        const open = await this.tx.$queryRaw<{ id: string }[]>`SELECT id FROM cash_sessions WHERE branch_id = ${branchId}::uuid AND status = 'open' FOR SHARE`;
        if (open[0]) return open[0].id;
        if (setting[0]?.value === true) throw new ConflictError('This branch has no open cash session: open one before selling');
        return null;
    }

    async fxSettings(): Promise<{ rate: number; step: number } | null> {
        const rows = await this.tx.$queryRaw<{ key: string; value: unknown }[]>`SELECT key, value FROM settings WHERE key IN ('exchangeRateUsdLbp', 'lbpRoundingStep')`;
        const rate = rows.find((r) => r.key === 'exchangeRateUsdLbp')?.value;
        if (typeof rate !== 'number') return null;
        const step = rows.find((r) => r.key === 'lbpRoundingStep')?.value;
        return { rate, step: typeof step === 'number' ? step : 1000 };
    }

    async insertSale(sale: Sale, idempotencyKeyId: string, actorId: string, cashSessionId: string | null = null): Promise<void> {
        try {
            await this.tx.sale.create({ data: { ...SaleMapper.toPersistence(sale, idempotencyKeyId, actorId), cashSessionId } as Prisma.SaleUncheckedCreateInput });
            // the cost of what is sold, kept on the day of the sale: the average cost at the warehouse, else the catalog cost a manager typed, else unknown (never zero)
            await this.tx.$executeRaw`
                INSERT INTO sale_line_costs (sale_line_id, unit_cost_snapshot, source)
                SELECT l.id, COALESCE(sc.avg_unit_cost, cc.unit_cost), CASE WHEN sc.avg_unit_cost IS NOT NULL THEN 'warehouse' WHEN cc.unit_cost IS NOT NULL THEN 'catalog' END
                FROM sale_lines l
                LEFT JOIN stock_costs sc ON sc.sku_id = l.sku_id AND sc.branch_id = (SELECT id FROM branches WHERE kind = 'warehouse' LIMIT 1)
                LEFT JOIN catalog_costs cc ON cc.sku_id = l.sku_id
                WHERE l.sale_id = ${sale.id}::uuid`;
        } catch (error) {
            // the unique index on the Whish reference has the last word: a transfer can pay only ONE thing
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
                throw new ConflictError('This Whish reference was already used for another payment');
            }
            throw error;
        }
    }

    async deductStock(branchId: string, saleId: string, items: { skuId: string; quantity: number }[], actorId: string, idempotencyKeyId: string): Promise<void> {
        for (const item of [...items].sort((a, b) => a.skuId.localeCompare(b.skuId))) {
            // the rows are already locked by lockSellableStock; the CHECK (quantity >= 0) is the last defence
            const updated = await this.tx.$queryRaw<{ quantity: number }[]>`
                UPDATE stock_balances SET quantity = quantity - ${item.quantity}
                WHERE sku_id = ${item.skuId}::uuid AND branch_id = ${branchId}::uuid AND bucket = 'sellable'
                RETURNING quantity`;
            await this.tx.stockMovement.create({
                data: {
                    skuId: item.skuId,
                    branchId,
                    bucket: 'sellable',
                    movementType: 'sale',
                    quantityDelta: -item.quantity,
                    balanceAfter: updated[0].quantity,
                    saleId,
                    actorUserId: actorId,
                    idempotencyKeyId,
                },
            });
        }
    }

    completeIdempotencyKey(idempotencyKeyId: string, resourceType: string, resourceId: string): Promise<void> {
        return completeIdempotencyKey(this.tx, idempotencyKeyId, resourceType, resourceId);
    }
}

export class SalesUnitOfWork implements ISalesUnitOfWork {
    constructor(private readonly prisma: PrismaClient) {}

    run<T>(work: (tx: SaleTransaction) => Promise<T>): Promise<T> {
        // a remote database (Neon) needs more than Prisma's default 5 seconds for a sale with many lines
        return this.prisma.$transaction((tx) => work(new PrismaSaleTransaction(tx)), { maxWait: 10_000, timeout: 30_000 });
    }
}
