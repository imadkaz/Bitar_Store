import { Prisma, PrismaClient } from '../generated/prisma/client';

export interface SaleHistoryRow {
    id: string;
    reference: string;
    branch: { id: string; code: string; name: string };
    soldAt: Date;
    businessDate: string;
    soldBy: { id: string; name: string | null };
    status: string;
    channel: string;
    items: number;
    total: string;
    totalDiscount: string;
    cash: string;
    whish: string;
}

// The sales of any period (a day, a week, a year) for the branches a person reaches, newest first.
export class SalesHistoryRepository {
    constructor(private readonly prisma: PrismaClient) {}

    async list(branchIds: string[], from: string, to: string, limit: number, offset: number): Promise<{ rows: SaleHistoryRow[]; total: number }> {
        if (branchIds.length === 0) return { rows: [], total: 0 };
        const ids = Prisma.join(branchIds.map((id) => Prisma.sql`${id}::uuid`));
        const where = Prisma.sql`s.branch_id IN (${ids}) AND s.business_date BETWEEN ${from}::date AND ${to}::date`;
        const [rows, count] = await Promise.all([
            this.prisma.$queryRaw<{
                id: string; reference: string; branch_id: string; branch_code: string; branch_name: string; sold_at: Date; business_date: string; sold_by: string; seller: string | null;
                status: string; channel: string; items: number; total: string; total_discount: string; cash: string; whish: string;
            }[]>(Prisma.sql`
                SELECT s.id, s.reference, s.branch_id, br.code AS branch_code, br.name AS branch_name, s.sold_at, s.business_date::text AS business_date,
                       s.sold_by, u.full_name AS seller, s.status, s.channel, s.total::text AS total, s.total_discount::text AS total_discount,
                       (SELECT COALESCE(SUM(l.quantity), 0)::int FROM sale_lines l WHERE l.sale_id = s.id) AS items,
                       (SELECT COALESCE(SUM(p.amount) FILTER (WHERE p.method = 'cash'), 0)::text FROM sale_payments p WHERE p.sale_id = s.id) AS cash,
                       (SELECT COALESCE(SUM(p.amount) FILTER (WHERE p.method = 'whish'), 0)::text FROM sale_payments p WHERE p.sale_id = s.id) AS whish
                FROM sales s
                JOIN branches br ON br.id = s.branch_id
                LEFT JOIN users u ON u.id = s.sold_by
                WHERE ${where}
                ORDER BY s.sold_at DESC, s.id DESC
                LIMIT ${limit} OFFSET ${offset}`),
            this.prisma.$queryRaw<{ n: number }[]>(Prisma.sql`SELECT COUNT(*)::int AS n FROM sales s WHERE ${where}`),
        ]);
        return {
            total: count[0].n,
            rows: rows.map((r) => ({
                id: r.id, reference: r.reference, branch: { id: r.branch_id, code: r.branch_code, name: r.branch_name }, soldAt: r.sold_at, businessDate: r.business_date,
                soldBy: { id: r.sold_by, name: r.seller }, status: r.status, channel: r.channel, items: r.items, total: r.total, totalDiscount: r.total_discount, cash: r.cash, whish: r.whish,
            })),
        };
    }
}
