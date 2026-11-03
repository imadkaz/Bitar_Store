import { Prisma, PrismaClient } from '../generated/prisma/client';
import { parseMoneyToCents } from '../models/Money';
import { DashboardOverviewData, IDashboardRepository } from './interfaces/IDashboardRepository';

const uuidList = (ids: string[]) => Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`));

export class DashboardRepository implements IDashboardRepository {
    constructor(private readonly prisma: PrismaClient) {}

    async overview(branchIds: string[], businessDate: string): Promise<DashboardOverviewData> {
        const [stock, locations, today] = await Promise.all([
            branchIds.length === 0
                ? Promise.resolve([{ products: 0, variants_in_stock: 0, total_units: 0, low_stock: 0, out_of_stock: 0 }])
                : this.prisma.$queryRaw<{
                    products: number; variants_in_stock: number; total_units: number; low_stock: number; out_of_stock: number;
                }[]>(Prisma.sql`
                    WITH sku_locations AS (
                        SELECT sk.id AS sku_id, sk.style_id, br.id AS branch_id,
                               COALESCE(SUM(sb.quantity) FILTER (WHERE sb.bucket = 'sellable'), 0)::int AS quantity,
                               BOOL_OR(sb.bucket = 'sellable') AS has_stock_row,
                               rl.min_quantity
                        FROM branches br
                        CROSS JOIN skus sk
                        LEFT JOIN stock_balances sb ON sb.sku_id = sk.id AND sb.branch_id = br.id
                        LEFT JOIN reorder_levels rl ON rl.sku_id = sk.id AND rl.branch_id = br.id
                        WHERE br.id IN (${uuidList(branchIds)})
                        GROUP BY sk.id, sk.style_id, br.id, rl.min_quantity
                    )
                    SELECT COUNT(DISTINCT style_id) FILTER (WHERE has_stock_row)::int AS products,
                           COUNT(DISTINCT sku_id) FILTER (WHERE quantity > 0)::int AS variants_in_stock,
                           COALESCE(SUM(quantity), 0)::int AS total_units,
                           COUNT(*) FILTER (WHERE quantity > 0 AND quantity <= min_quantity)::int AS low_stock,
                           COUNT(*) FILTER (WHERE quantity = 0)::int AS out_of_stock
                    FROM sku_locations`),
            this.prisma.$queryRaw<{ warehouses: number; branches: number }[]>(Prisma.sql`
                SELECT COUNT(*) FILTER (WHERE kind = 'warehouse')::int AS warehouses,
                       COUNT(*) FILTER (WHERE kind = 'branch')::int AS branches
                FROM branches`),
            branchIds.length === 0
                ? Promise.resolve([{ docs: 0, revenue: '0' }])
                : this.prisma.$queryRaw<{ docs: number; revenue: string }[]>(Prisma.sql`
                    SELECT COUNT(*)::int AS docs, COALESCE(SUM(total), 0)::text AS revenue
                    FROM sales
                    WHERE business_date = ${businessDate}::date
                      AND branch_id IN (${uuidList(branchIds)})
                      AND status <> 'reversed'`),
        ]);

        return {
            stock: {
                products: stock[0].products,
                variantsInStock: stock[0].variants_in_stock,
                totalUnits: stock[0].total_units,
                lowStock: stock[0].low_stock,
                outOfStock: stock[0].out_of_stock,
            },
            locations: locations[0],
            today: { docs: today[0].docs, revenueCents: parseMoneyToCents(today[0].revenue, 'Revenue') },
        };
    }
}
