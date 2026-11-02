import { Prisma, PrismaClient } from '../generated/prisma/client';
import { BUSINESS_TIME_ZONE } from '../utils/businessDate';
import { AdjustmentListFilter, AdjustmentView, IAdjustmentRepository } from './interfaces/IAdjustmentRepository';

interface Row {
    id: string; reference: string; branch_id: string; branch_code: string; branch_name: string; sku_id: string; sku_code: string; style_name: string; size: string; color: string;
    bucket: string; quantity_delta: number; reason: string; note: string; adjusted_by: string; adjuster: string | null; created_at: Date; balance_after: number | null;
}

const SELECT = Prisma.sql`
    SELECT a.id, a.reference, a.branch_id, br.code AS branch_code, br.name AS branch_name, a.sku_id, k.sku_code, st.name AS style_name, k.size, k.color,
           a.bucket, a.quantity_delta, a.reason, a.note, a.adjusted_by, u.full_name AS adjuster, a.created_at,
           (SELECT m.balance_after FROM stock_movements m WHERE m.adjustment_id = a.id AND m.bucket = a.bucket ORDER BY m.occurred_at DESC LIMIT 1) AS balance_after
    FROM adjustments a
    JOIN branches br ON br.id = a.branch_id
    JOIN skus k ON k.id = a.sku_id
    JOIN styles st ON st.id = k.style_id
    LEFT JOIN users u ON u.id = a.adjusted_by`;

const toView = (r: Row): AdjustmentView => ({
    id: r.id, reference: r.reference, branch: { id: r.branch_id, code: r.branch_code, name: r.branch_name },
    sku: { id: r.sku_id, code: r.sku_code, styleName: r.style_name, size: r.size, color: r.color },
    bucket: r.bucket, quantityDelta: r.quantity_delta, reason: r.reason, note: r.note, by: { id: r.adjusted_by, name: r.adjuster }, createdAt: r.created_at, balanceAfter: r.balance_after,
});

export class AdjustmentRepository implements IAdjustmentRepository {
    constructor(private readonly prisma: PrismaClient) {}

    async findById(id: string): Promise<AdjustmentView | null> {
        const rows = await this.prisma.$queryRaw<Row[]>(Prisma.sql`${SELECT} WHERE a.id = ${id}::uuid`);
        return rows.length === 0 ? null : toView(rows[0]);
    }

    async list(filter: AdjustmentListFilter): Promise<{ items: AdjustmentView[]; total: number }> {
        if (filter.branchIds.length === 0) return { items: [], total: 0 };
        const ids = Prisma.join(filter.branchIds.map((id) => Prisma.sql`${id}::uuid`));
        const sku = filter.skuId ? Prisma.sql`AND a.sku_id = ${filter.skuId}::uuid` : Prisma.empty;
        const reason = filter.reason ? Prisma.sql`AND a.reason = ${filter.reason}` : Prisma.empty;
        const from = filter.from ? Prisma.sql`AND a.created_at >= (${filter.from}::date)::timestamp AT TIME ZONE ${BUSINESS_TIME_ZONE}` : Prisma.empty;
        const to = filter.to ? Prisma.sql`AND a.created_at < ((${filter.to}::date + 1))::timestamp AT TIME ZONE ${BUSINESS_TIME_ZONE}` : Prisma.empty;
        const where = Prisma.sql`a.branch_id IN (${ids}) ${sku} ${reason} ${from} ${to}`;
        const [rows, count] = await Promise.all([
            this.prisma.$queryRaw<Row[]>(Prisma.sql`${SELECT} WHERE ${where} ORDER BY a.created_at DESC, a.id DESC LIMIT ${filter.limit} OFFSET ${filter.offset}`),
            this.prisma.$queryRaw<{ n: number }[]>(Prisma.sql`SELECT COUNT(*)::int AS n FROM adjustments a WHERE ${where}`),
        ]);
        return { items: rows.map(toView), total: count[0].n };
    }
}
