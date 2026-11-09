import { AuthContext } from '../../models/AuthContext';
import { parseMoneyToCents, formatCents } from '../../models/Money';
import { canViewCosts } from '../../models/Permission';
import { PrismaClient } from '../../generated/prisma/client';
import { writeAudit } from '../../repositories/audit';
import { ForbiddenError } from '../../utils/exeptions/ForbiddenError';
import { NotFoundError } from '../../utils/exeptions/NotFoundError';
import { ValidationError } from '../../utils/exeptions/ValidationError';
import { isUuid } from '../../utils/uuid';

// The cost of a piece is a secret of the managers (canViewCosts): the catalog cost a manager types, and what the warehouse paid on average.
export interface SkuCostView { skuId: string; skuCode: string; catalogCost: string | null; warehouseAverageCost: string | null }

const MAX_COST_CENTS = 10_000_000;       // 100,000.00 per piece
const need = (auth: AuthContext) => { if (!canViewCosts(auth.user.getRole())) throw new ForbiddenError('Only an admin or a manager can see or set costs'); };
const idOf = (raw: string) => { if (!isUuid(raw)) throw new NotFoundError('Sku not found'); return raw; };

export class SkuCostUsecases {
    constructor(private readonly prisma: PrismaClient) {}

    async get(rawId: string, auth: AuthContext): Promise<SkuCostView> {
        need(auth);
        const id = idOf(rawId);
        const rows = await this.prisma.$queryRaw<{ sku_code: string; catalog: string | null; warehouse: string | null }[]>`
            SELECT k.sku_code, cc.unit_cost::text AS catalog,
                   (SELECT sc.avg_unit_cost::text FROM stock_costs sc JOIN branches b ON b.id = sc.branch_id AND b.kind = 'warehouse' WHERE sc.sku_id = k.id LIMIT 1) AS warehouse
            FROM skus k LEFT JOIN catalog_costs cc ON cc.sku_id = k.id WHERE k.id = ${id}::uuid`;
        if (rows.length === 0) throw new NotFoundError('Sku not found');
        return { skuId: id, skuCode: rows[0].sku_code, catalogCost: rows[0].catalog, warehouseAverageCost: rows[0].warehouse };
    }

    // body: { unitCost: "12.50" } sets it, { unitCost: null } clears it. It is used when the warehouse has no average cost yet.
    async set(rawId: string, body: unknown, auth: AuthContext): Promise<SkuCostView> {
        need(auth);
        const id = idOf(rawId);
        if (typeof body !== 'object' || body === null || Array.isArray(body) || !('unitCost' in body)) throw new ValidationError('unitCost is required (a number, or null to clear it)');
        const value = (body as { unitCost: unknown }).unitCost;
        let cents: number | null = null;
        if (value !== null) {
            cents = parseMoneyToCents(value as string | number, 'unitCost');
            if (cents < 0 || cents > MAX_COST_CENTS) throw new ValidationError('unitCost must be between 0 and 100,000.00');
        }
        const actorId = auth.user.getId();
        await this.prisma.$transaction(async (tx) => {
            const sku = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM skus WHERE id = ${id}::uuid FOR UPDATE`;
            if (sku.length === 0) throw new NotFoundError('Sku not found');
            const before = await tx.$queryRaw<{ unit_cost: string }[]>`SELECT unit_cost::text AS unit_cost FROM catalog_costs WHERE sku_id = ${id}::uuid`;
            if (cents === null) await tx.$executeRaw`DELETE FROM catalog_costs WHERE sku_id = ${id}::uuid`;
            else await tx.$executeRaw`INSERT INTO catalog_costs (sku_id, unit_cost, updated_by, updated_at) VALUES (${id}::uuid, ${formatCents(cents)}::numeric, ${actorId}::uuid, now())
                                      ON CONFLICT (sku_id) DO UPDATE SET unit_cost = EXCLUDED.unit_cost, updated_by = EXCLUDED.updated_by, updated_at = now()`;
            await writeAudit(tx, { actorId, action: 'sku.cost_set', entityType: 'sku', entityId: id, details: { before: before[0]?.unit_cost ?? null, after: cents === null ? null : (cents / 100).toFixed(4) } });
        });
        return this.get(id, auth);
    }
}

// profit = what was sold minus what it cost, on the cost kept on the day of each sale. Lines whose cost was unknown are not guessed: their revenue is shown apart.
// revenue, cost and profit are what was SOLD. refunds = what the returns approved in the period give back (at the branch that took the goods); returnedCost = what those pieces cost (they are back in the stock);
// netRevenue = revenue - refunds; netProfit = profit - the refunds of pieces whose cost is known + returnedCost: it equals the profit of what was kept by the customers.
export interface ProfitRow { branchId: string; revenue: string; cost: string; profit: string; unknownCostRevenue: string; salesCount: number; refunds: string; returnedCost: string; netRevenue: string; netProfit: string }

export class GetProfitUsecase {
    constructor(private readonly prisma: PrismaClient, private readonly resolveScope: (auth: AuthContext, branchId: unknown) => Promise<string[]>, private readonly range: (from: unknown, to: unknown) => { from: string; to: string }) {}

    async execute(input: { branchId?: unknown; from?: unknown; to?: unknown }, auth: AuthContext): Promise<{ from: string; to: string; totals: Omit<ProfitRow, 'branchId'>; byBranch: ProfitRow[] }> {
        if (!auth.can('reports.financial')) throw new ForbiddenError('Missing permission: reports.financial');
        need(auth);
        const { from, to } = this.range(input.from, input.to);
        const branchIds = await this.resolveScope(auth, input.branchId);
        if (branchIds.length === 0) return { from, to, totals: { revenue: '0.00', cost: '0.00', profit: '0.00', unknownCostRevenue: '0.00', salesCount: 0, refunds: '0.00', returnedCost: '0.00', netRevenue: '0.00', netProfit: '0.00' }, byBranch: [] };
        const rows = await this.prisma.$queryRaw<{ branch_id: string; revenue: string; cost: string; known: string; n: number }[]>`
            SELECT s.branch_id, COALESCE(SUM(l.line_total), 0)::numeric(14,2)::text AS revenue,
                   COALESCE(SUM(l.quantity * c.unit_cost_snapshot), 0)::numeric(14,2)::text AS cost,
                   COALESCE(SUM(l.line_total) FILTER (WHERE c.unit_cost_snapshot IS NOT NULL), 0)::numeric(14,2)::text AS known,
                   COUNT(DISTINCT s.id)::int AS n
            FROM sales s JOIN sale_lines l ON l.sale_id = s.id LEFT JOIN sale_line_costs c ON c.sale_line_id = l.id
            WHERE s.branch_id = ANY(${branchIds}::uuid[]) AND s.business_date BETWEEN ${from}::date AND ${to}::date AND s.status <> 'reversed'
            GROUP BY s.branch_id`;
        const returned = await this.prisma.$queryRaw<{ branch_id: string; refunds: string; refunds_known: string; returned_cost: string }[]>`
            SELECT r.receiving_branch_id AS branch_id, COALESCE(SUM(l.refund_value), 0)::numeric(14,2)::text AS refunds,
                   COALESCE(SUM(l.refund_value) FILTER (WHERE c.unit_cost_snapshot IS NOT NULL), 0)::numeric(14,2)::text AS refunds_known,
                   COALESCE(SUM(l.quantity * c.unit_cost_snapshot), 0)::numeric(14,2)::text AS returned_cost
            FROM returns r JOIN return_lines l ON l.return_id = r.id LEFT JOIN sale_line_costs c ON c.sale_line_id = l.sale_line_id
            WHERE r.status = 'approved' AND r.receiving_branch_id = ANY(${branchIds}::uuid[]) AND (r.decided_at AT TIME ZONE 'Asia/Beirut')::date BETWEEN ${from}::date AND ${to}::date
            GROUP BY r.receiving_branch_id`;
        const cents = (v: string) => Math.round(Number(v) * 100);
        const byBranch = branchIds.map((id) => {
            const r = rows.find((x) => x.branch_id === id), back = returned.find((x) => x.branch_id === id);
            const revenue = r ? cents(r.revenue) : 0, cost = r ? cents(r.cost) : 0, known = r ? cents(r.known) : 0;
            const refunds = back ? cents(back.refunds) : 0, refundsKnown = back ? cents(back.refunds_known) : 0, returnedCost = back ? cents(back.returned_cost) : 0;
            return { branchId: id, revenue: formatCents(revenue), cost: formatCents(cost), profit: formatCents(known - cost), unknownCostRevenue: formatCents(revenue - known), salesCount: r?.n ?? 0,
                refunds: formatCents(refunds), returnedCost: formatCents(returnedCost), netRevenue: formatCents(revenue - refunds), netProfit: formatCents(known - cost - refundsKnown + returnedCost) };
        });
        const sum = (f: (r: ProfitRow) => string) => byBranch.reduce((n, r) => n + cents(f(r)), 0);
        return { from, to, byBranch, totals: { revenue: formatCents(sum((r) => r.revenue)), cost: formatCents(sum((r) => r.cost)), profit: formatCents(sum((r) => r.profit)), unknownCostRevenue: formatCents(sum((r) => r.unknownCostRevenue)), salesCount: byBranch.reduce((n, r) => n + r.salesCount, 0),
            refunds: formatCents(sum((r) => r.refunds)), returnedCost: formatCents(sum((r) => r.returnedCost)), netRevenue: formatCents(sum((r) => r.netRevenue)), netProfit: formatCents(sum((r) => r.netProfit)) } };
    }
}
