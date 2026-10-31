import { Prisma, PrismaClient } from '../generated/prisma/client';
import { parseMoneyToCents } from '../models/Money';
import { IReportRepository, ReplenishmentRow, ReportScope, SalesSummaryRow, TopSkuRow } from './interfaces/IReportRepository';

const uuidList = (ids: string[]) => Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`));
const cents = (text: string | null) => parseMoneyToCents(text ?? '0', 'Amount');

// All the numbers are computed by the database (sums, counts, groups); the money comes back as text, never as a float.
export class ReportRepository implements IReportRepository {
    constructor(private readonly prisma: PrismaClient) {}

    async salesSummary(scope: ReportScope): Promise<SalesSummaryRow[]> {
        if (scope.branchIds.length === 0) return [];
        const rows = await this.prisma.$queryRaw<{
            branch_id: string; day: string; sales_count: number; items: number; revenue: string; discounts: string;
            cash: string; whish: string; in_store: string; social_media: string;
        }[]>(Prisma.sql`
            WITH pay AS (
                SELECT sale_id,
                       SUM(amount) FILTER (WHERE method = 'cash')  AS cash,
                       SUM(amount) FILTER (WHERE method = 'whish') AS whish
                FROM sale_payments GROUP BY sale_id
            ), items AS (
                SELECT sale_id, SUM(quantity) AS qty FROM sale_lines GROUP BY sale_id
            )
            SELECT s.branch_id, s.business_date::text AS day,
                   COUNT(*)::int AS sales_count,
                   COALESCE(SUM(i.qty), 0)::int AS items,
                   SUM(s.total)::text AS revenue,
                   SUM(s.total_discount)::text AS discounts,
                   COALESCE(SUM(p.cash), 0)::text AS cash,
                   COALESCE(SUM(p.whish), 0)::text AS whish,
                   COALESCE(SUM(s.total) FILTER (WHERE s.channel = 'in_store'), 0)::text AS in_store,
                   COALESCE(SUM(s.total) FILTER (WHERE s.channel = 'social_media'), 0)::text AS social_media
            FROM sales s
            LEFT JOIN pay p ON p.sale_id = s.id
            LEFT JOIN items i ON i.sale_id = s.id
            WHERE s.branch_id IN (${uuidList(scope.branchIds)})
              AND s.business_date BETWEEN ${scope.from}::date AND ${scope.to}::date
              AND s.status <> 'reversed'
            GROUP BY s.branch_id, s.business_date
            ORDER BY s.business_date DESC, s.branch_id`);
        return rows.map((r) => ({
            branchId: r.branch_id, day: r.day, salesCount: r.sales_count, items: r.items, revenueCents: cents(r.revenue), discountCents: cents(r.discounts),
            cashCents: cents(r.cash), whishCents: cents(r.whish), inStoreCents: cents(r.in_store), socialMediaCents: cents(r.social_media),
        }));
    }

    async topSkus(scope: ReportScope, limit: number): Promise<TopSkuRow[]> {
        if (scope.branchIds.length === 0) return [];
        const rows = await this.prisma.$queryRaw<{
            sku_id: string; sku_code: string; style_name: string; size: string; color: string; quantity: number; revenue: string; sales_count: number;
        }[]>(Prisma.sql`
            SELECT l.sku_id, k.sku_code, st.name AS style_name, k.size, k.color,
                   SUM(l.quantity)::int AS quantity, SUM(l.line_total)::text AS revenue, COUNT(DISTINCT s.id)::int AS sales_count
            FROM sale_lines l
            JOIN sales s ON s.id = l.sale_id
            JOIN skus k ON k.id = l.sku_id
            JOIN styles st ON st.id = k.style_id
            WHERE s.branch_id IN (${uuidList(scope.branchIds)})
              AND s.business_date BETWEEN ${scope.from}::date AND ${scope.to}::date
              AND s.status <> 'reversed'
            GROUP BY l.sku_id, k.sku_code, st.name, k.size, k.color
            ORDER BY quantity DESC, SUM(l.line_total) DESC, k.sku_code
            LIMIT ${limit}`);
        return rows.map((r) => ({
            skuId: r.sku_id, skuCode: r.sku_code, styleName: r.style_name, size: r.size, color: r.color,
            quantity: r.quantity, revenueCents: cents(r.revenue), salesCount: r.sales_count,
        }));
    }

    async replenishment(branchIds: string[]): Promise<ReplenishmentRow[]> {
        if (branchIds.length === 0) return [];
        const rows = await this.prisma.$queryRaw<{
            branch_id: string; sku_id: string; sku_code: string; style_name: string; size: string; color: string;
            sellable: number; in_transit: number; min_quantity: number; target_quantity: number | null;
        }[]>(Prisma.sql`
            SELECT rl.branch_id, rl.sku_id, k.sku_code, st.name AS style_name, k.size, k.color, rl.min_quantity, rl.target_quantity,
                   COALESCE(SUM(b.quantity) FILTER (WHERE b.bucket = 'sellable'), 0)::int   AS sellable,
                   COALESCE(SUM(b.quantity) FILTER (WHERE b.bucket = 'in_transit'), 0)::int AS in_transit
            FROM reorder_levels rl
            JOIN skus k ON k.id = rl.sku_id AND k.is_active
            JOIN styles st ON st.id = k.style_id
            JOIN branches br ON br.id = rl.branch_id AND br.is_active AND br.kind = 'branch'
            LEFT JOIN stock_balances b ON b.sku_id = rl.sku_id AND b.branch_id = rl.branch_id
            WHERE rl.branch_id IN (${uuidList(branchIds)})
            GROUP BY rl.id, br.code, k.sku_code, st.name, k.size, k.color
            HAVING COALESCE(SUM(b.quantity) FILTER (WHERE b.bucket IN ('sellable', 'in_transit')), 0) < rl.min_quantity
            ORDER BY br.code, k.sku_code`);
        return rows.map((r) => ({
            branchId: r.branch_id, skuId: r.sku_id, skuCode: r.sku_code, styleName: r.style_name, size: r.size, color: r.color,
            sellable: r.sellable, inTransit: r.in_transit, minQuantity: r.min_quantity, targetQuantity: r.target_quantity,
        }));
    }

    async sellableAt(branchId: string, skuIds: string[]): Promise<Map<string, number>> {
        if (skuIds.length === 0) return new Map();
        const rows = await this.prisma.stockBalance.findMany({ where: { branchId, bucket: 'sellable', skuId: { in: skuIds } } });
        return new Map(rows.map((r) => [r.skuId, r.quantity]));
    }
}
