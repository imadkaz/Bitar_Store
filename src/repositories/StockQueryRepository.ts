import { Prisma, PrismaClient } from '../generated/prisma/client';
import { BUSINESS_TIME_ZONE } from '../utils/businessDate';
import { IStockQueryRepository, MovementFilter, MovementView, Quantities } from './interfaces/IStockQueryRepository';

export class StockQueryRepository implements IStockQueryRepository {
    constructor(private readonly prisma: PrismaClient) {}

    async quantities(skuIds: string[]): Promise<Map<string, Map<string, Quantities>>> {
        const result = new Map<string, Map<string, Quantities>>();
        if (skuIds.length === 0) return result;
        const rows = await this.prisma.stockBalance.findMany({ where: { skuId: { in: skuIds } } });
        for (const row of rows) {
            const perBranch = result.get(row.skuId) ?? new Map<string, Quantities>();
            const q = perBranch.get(row.branchId) ?? { sellable: 0, nonSellable: 0, inTransit: 0 };
            if (row.bucket === 'sellable') q.sellable = row.quantity;
            else if (row.bucket === 'non_sellable') q.nonSellable = row.quantity;
            else if (row.bucket === 'in_transit') q.inTransit = row.quantity;
            perBranch.set(row.branchId, q);
            result.set(row.skuId, perBranch);
        }
        return result;
    }

    // The ledger of one place, newest first. A shop day runs from midnight to midnight in Lebanon, not in UTC.
    async movements(filter: MovementFilter): Promise<MovementView[]> {
        const sku = filter.skuId ? Prisma.sql`AND m.sku_id = ${filter.skuId}::uuid` : Prisma.empty;
        const type = filter.movementType ? Prisma.sql`AND m.movement_type = ${filter.movementType}` : Prisma.empty;
        const from = filter.from ? Prisma.sql`AND m.occurred_at >= (${filter.from}::date)::timestamp AT TIME ZONE ${BUSINESS_TIME_ZONE}` : Prisma.empty;
        const to = filter.to ? Prisma.sql`AND m.occurred_at < ((${filter.to}::date + 1))::timestamp AT TIME ZONE ${BUSINESS_TIME_ZONE}` : Prisma.empty;
        const rows = await this.prisma.$queryRaw<{
            id: string; occurred_at: Date; movement_type: string; bucket: string; quantity_delta: number; balance_after: number;
            sku_id: string; sku_code: string; actor_user_id: string; actor_name: string | null; sale_id: string | null; reason: string | null;
        }[]>(Prisma.sql`
            SELECT m.id, m.occurred_at, m.movement_type, m.bucket, m.quantity_delta, m.balance_after, m.sku_id, k.sku_code,
                   m.actor_user_id, u.full_name AS actor_name, m.sale_id, m.reason
            FROM stock_movements m
            JOIN skus k ON k.id = m.sku_id
            LEFT JOIN users u ON u.id = m.actor_user_id
            WHERE m.branch_id = ${filter.branchId}::uuid ${sku} ${type} ${from} ${to}
            ORDER BY m.occurred_at DESC, m.id DESC
            LIMIT ${filter.limit} OFFSET ${filter.offset}`);
        return rows.map((r) => ({
            id: r.id, occurredAt: r.occurred_at, movementType: r.movement_type, bucket: r.bucket, quantityDelta: r.quantity_delta,
            balanceAfter: r.balance_after, skuId: r.sku_id, skuCode: r.sku_code, actorId: r.actor_user_id, actorName: r.actor_name,
            saleId: r.sale_id, reason: r.reason,
        }));
    }
}
