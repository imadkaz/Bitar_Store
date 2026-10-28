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

    async insertSale(sale: Sale, idempotencyKeyId: string, actorId: string): Promise<void> {
        try {
            await this.tx.sale.create({ data: SaleMapper.toPersistence(sale, idempotencyKeyId, actorId) as Prisma.SaleUncheckedCreateInput });
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
