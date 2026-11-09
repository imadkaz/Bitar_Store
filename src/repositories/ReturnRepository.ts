import { Prisma, PrismaClient } from '../generated/prisma/client';
import { CreateReturnRequest, refundValueCents } from '../models/Return.model';
import { formatCents } from '../models/Money';
import { BUSINESS_TIME_ZONE, businessDateOf } from '../utils/businessDate';
import { ConflictError } from '../utils/exeptions/ConflictError';
import { NotFoundError } from '../utils/exeptions/NotFoundError';
import { ForbiddenError } from '../utils/exeptions/ForbiddenError';
import { writeAudit } from './audit';
import { claimIdempotencyKey, completeIdempotencyKey } from './idempotency';
import { IReturnRepository, ReturnableSale, ReturnListFilter, ReturnSummary, ReturnView } from './interfaces/IReturnRepository';

const TX = { maxWait: 10_000, timeout: 30_000 };
const cents = (decimal: string | null): number => (decimal === null ? 0 : Math.round(Number(decimal) * 100));
const person = (id: string | null, name: string | null) => ({ id: id as string, name });
type Q = { $queryRaw: PrismaClient['$queryRaw'] };
const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

async function returnPeriodDays(q: Q): Promise<number> {
    const rows = await q.$queryRaw<{ value: unknown }[]>`SELECT value FROM settings WHERE key = 'returnPeriodDays'`;
    return typeof rows[0]?.value === 'number' ? rows[0].value : 14;
}
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

async function loadReturn(q: Q, id: string): Promise<ReturnView | null> {
    const rows = await q.$queryRaw<{ id: string; reference: string; status: ReturnView['status']; custody: ReturnView['custody']; sale_id: string; sale_ref: string; sale_branch_id: string; sale_branch: string; sold_at: Date;
        branch_id: string; branch_code: string; branch_name: string; reason: string; note: string | null; late: string | null; refund_total: string | null; received_by: string; receiver: string | null; received_at: Date;
        decided_by: string | null; decider: string | null; decided_at: Date | null; decision_reason: string | null; handed_back_to: string | null; handed_back_by: string | null; backer: string | null; handed_back_at: Date | null;
        ex_sale_id: string | null; ex_sale_ref: string | null; ex_sale_total: string | null; ex_net: string | null; ex_by: string | null; ex_by_name: string | null; ex_at: Date | null }[]>`
        SELECT r.id, r.reference, r.status, r.custody, r.sale_id, s.reference AS sale_ref, s.branch_id AS sale_branch_id, sb.name AS sale_branch, s.sold_at, b.id AS branch_id, b.code AS branch_code, b.name AS branch_name,
               r.reason, r.note, r.late_exception_reason AS late, r.refund_total::text AS refund_total, r.received_by, ru.full_name AS receiver, r.received_at, r.decided_by, du.full_name AS decider, r.decided_at, r.decision_reason,
               r.handed_back_to, r.handed_back_by, hu.full_name AS backer, r.handed_back_at,
               r.exchange_sale_id AS ex_sale_id, xs.reference AS ex_sale_ref, xs.total::text AS ex_sale_total, r.exchange_net::text AS ex_net, r.exchange_linked_by AS ex_by, xu.full_name AS ex_by_name, r.exchange_linked_at AS ex_at
        FROM returns r JOIN sales s ON s.id = r.sale_id JOIN branches sb ON sb.id = s.branch_id JOIN branches b ON b.id = r.receiving_branch_id
        LEFT JOIN users ru ON ru.id = r.received_by LEFT JOIN users du ON du.id = r.decided_by LEFT JOIN users hu ON hu.id = r.handed_back_by
        LEFT JOIN sales xs ON xs.id = r.exchange_sale_id LEFT JOIN users xu ON xu.id = r.exchange_linked_by
        WHERE r.id = ${id}::uuid`;
    if (rows.length === 0) return null;
    const r = rows[0];
    const lines = await q.$queryRaw<{ id: string; sale_line_id: string; sku_id: string; sku_code: string; description: string; quantity: number; condition: ReturnView['lines'][number]['condition']; refund_value: string | null; released_qty: number }[]>`
        SELECT l.id, l.sale_line_id, l.sku_id, k.sku_code, st.name || ', ' || k.size || ', ' || k.color AS description, l.quantity, l.condition, l.refund_value::text AS refund_value, l.released_qty
        FROM return_lines l JOIN skus k ON k.id = l.sku_id JOIN styles st ON st.id = k.style_id WHERE l.return_id = ${id}::uuid ORDER BY k.sku_code`;
    const payments = await q.$queryRaw<{ id: string; method: 'cash' | 'whish'; amount: string; recipient: string; reference: string | null; paid_by: string; payer: string | null; paid_at: Date }[]>`
        SELECT p.id, p.method, p.amount::text AS amount, p.recipient, p.reference, p.paid_by, u.full_name AS payer, p.paid_at FROM return_refund_payments p LEFT JOIN users u ON u.id = p.paid_by WHERE p.return_id = ${id}::uuid ORDER BY p.paid_at, p.id`;
    const paid = payments.reduce((n, p) => n + cents(p.amount), 0);
    const total = r.refund_total === null ? null : cents(r.refund_total);
    return {
        id: r.id, reference: r.reference, status: r.status, custody: r.custody,
        sale: { id: r.sale_id, reference: r.sale_ref, branch: { id: r.sale_branch_id, name: r.sale_branch }, soldAt: r.sold_at },
        receivingBranch: { id: r.branch_id, code: r.branch_code, name: r.branch_name }, reason: r.reason, note: r.note, lateExceptionReason: r.late, receivedBy: person(r.received_by, r.receiver), receivedAt: r.received_at,
        decision: r.decided_by ? { by: person(r.decided_by, r.decider), at: r.decided_at as Date, reason: r.decision_reason } : null,
        handback: r.handed_back_by ? { to: r.handed_back_to as string, by: person(r.handed_back_by, r.backer), at: r.handed_back_at as Date } : null,
        lines: lines.map((l) => ({ id: l.id, saleLineId: l.sale_line_id, sku: { id: l.sku_id, code: l.sku_code }, description: l.description, quantity: l.quantity, condition: l.condition, refundValue: l.refund_value, releasedQty: l.released_qty, onHold: r.status === 'approved' ? l.quantity - l.released_qty : 0 })),
        exchange: r.ex_sale_id === null ? null : { saleId: r.ex_sale_id, saleReference: r.ex_sale_ref as string, saleTotal: r.ex_sale_total as string, refundTotal: formatCents(total ?? 0), net: r.ex_net as string,
            direction: cents(r.ex_net) > 0 ? 'customer_pays' : cents(r.ex_net) < 0 ? 'business_pays' : 'even', linkedBy: person(r.ex_by, r.ex_by_name), linkedAt: r.ex_at as Date },
        refund: total === null ? null : { total: formatCents(total), paid: formatCents(paid), outstanding: formatCents(total - paid), status: total - paid > 0 ? 'pending' : 'paid',
            payments: payments.map((p) => ({ id: p.id, method: p.method, amount: p.amount, recipient: p.recipient, reference: p.reference, by: person(p.paid_by, p.payer), at: p.paid_at })) },
    };
}

// the stock rows of a product at a branch: created BEFORE they are locked, and locked in the same order by everybody (see the deadlock found in the adjustments)
async function lockBuckets(tx: Prisma.TransactionClient, branchId: string, skuId: string, buckets: ('sellable' | 'non_sellable')[]): Promise<Map<string, number>> {
    const sorted = [...buckets].sort();
    for (const bucket of sorted) await tx.$executeRaw`INSERT INTO stock_balances (sku_id, branch_id, bucket, quantity) VALUES (${skuId}::uuid, ${branchId}::uuid, ${bucket}, 0) ON CONFLICT (sku_id, branch_id, bucket) DO NOTHING`;
    const rows = await tx.$queryRaw<{ bucket: string; quantity: number }[]>`
        SELECT bucket, quantity FROM stock_balances WHERE branch_id = ${branchId}::uuid AND sku_id = ${skuId}::uuid AND bucket = ANY(${sorted}::text[]) ORDER BY bucket FOR UPDATE`;
    return new Map(rows.map((r) => [r.bucket, r.quantity]));
}
async function moveStock(tx: Prisma.TransactionClient, m: { skuId: string; branchId: string; bucket: 'sellable' | 'non_sellable'; delta: number; type: 'return_approval' | 'return_release'; returnId: string; actorId: string; keyId: string; reason: string }): Promise<void> {
    const rows = await tx.$queryRaw<{ quantity: number }[]>`UPDATE stock_balances SET quantity = quantity + ${m.delta}::int WHERE sku_id = ${m.skuId}::uuid AND branch_id = ${m.branchId}::uuid AND bucket = ${m.bucket} RETURNING quantity`;
    await tx.$executeRaw`
        INSERT INTO stock_movements (sku_id, branch_id, bucket, movement_type, quantity_delta, balance_after, return_id, reason, actor_user_id, idempotency_key_id)
        VALUES (${m.skuId}::uuid, ${m.branchId}::uuid, ${m.bucket}, ${m.type}, ${m.delta}::int, ${rows[0].quantity}::int, ${m.returnId}::uuid, ${m.reason}, ${m.actorId}::uuid, ${m.keyId}::uuid)`;
}

export class ReturnRepository implements IReturnRepository {
    constructor(private readonly prisma: PrismaClient) {}

    findById(id: string) { return loadReturn(this.prisma, id); }

    async branchesOf(returnId: string) {
        const rows = await this.prisma.$queryRaw<{ r: string; s: string }[]>`SELECT r.receiving_branch_id AS r, s.branch_id AS s FROM returns r JOIN sales s ON s.id = r.sale_id WHERE r.id = ${returnId}::uuid`;
        return rows[0] ? { receivingBranchId: rows[0].r, saleBranchId: rows[0].s } : null;
    }

    async list(filter: ReturnListFilter): Promise<{ items: ReturnSummary[]; total: number }> {
        if (filter.branchIds !== null && filter.branchIds.length === 0) return { items: [], total: 0 };
        const ids = filter.branchIds === null ? null : Prisma.join(filter.branchIds.map((id) => Prisma.sql`${id}::uuid`));
        const scope = ids === null ? Prisma.empty : Prisma.sql`AND (r.receiving_branch_id IN (${ids}) OR s.branch_id IN (${ids}))`;
        const branch = filter.branchId ? Prisma.sql`AND (r.receiving_branch_id = ${filter.branchId}::uuid OR s.branch_id = ${filter.branchId}::uuid)` : Prisma.empty;
        const sale = filter.saleId ? Prisma.sql`AND r.sale_id = ${filter.saleId}::uuid` : Prisma.empty;
        const status = filter.status ? Prisma.sql`AND r.status = ${filter.status}` : Prisma.empty;
        const from = filter.from ? Prisma.sql`AND r.received_at >= (${filter.from}::date)::timestamp AT TIME ZONE ${BUSINESS_TIME_ZONE}` : Prisma.empty;
        const to = filter.to ? Prisma.sql`AND r.received_at < ((${filter.to}::date + 1))::timestamp AT TIME ZONE ${BUSINESS_TIME_ZONE}` : Prisma.empty;
        const where = Prisma.sql`TRUE ${scope} ${branch} ${sale} ${status} ${from} ${to}`;
        const [rows, count] = await Promise.all([
            this.prisma.$queryRaw<{ id: string; reference: string; status: ReturnView['status']; sale_ref: string; branch_id: string; branch_name: string; received_at: Date; units: number; refund_total: string | null; paid: string }[]>(Prisma.sql`
                SELECT r.id, r.reference, r.status, s.reference AS sale_ref, b.id AS branch_id, b.name AS branch_name, r.received_at, (SELECT COALESCE(SUM(quantity), 0)::int FROM return_lines WHERE return_id = r.id) AS units,
                       r.refund_total::text AS refund_total, (SELECT COALESCE(SUM(amount), 0)::text FROM return_refund_payments WHERE return_id = r.id) AS paid
                FROM returns r JOIN sales s ON s.id = r.sale_id JOIN branches b ON b.id = r.receiving_branch_id WHERE ${where} ORDER BY r.received_at DESC, r.id DESC LIMIT ${filter.limit} OFFSET ${filter.offset}`),
            this.prisma.$queryRaw<{ n: number }[]>(Prisma.sql`SELECT COUNT(*)::int AS n FROM returns r JOIN sales s ON s.id = r.sale_id WHERE ${where}`),
        ]);
        return { items: rows.map((r) => ({ id: r.id, reference: r.reference, status: r.status, saleReference: r.sale_ref, receivingBranch: { id: r.branch_id, name: r.branch_name }, receivedAt: r.received_at, units: r.units,
            refundTotal: r.refund_total, refundOutstanding: r.refund_total === null ? null : formatCents(cents(r.refund_total) - cents(r.paid)) })), total: count[0].n };
    }

    // a sale found by its id or its reference (S-00000012): what can still be returned from it, at any branch
    async returnable(saleKey: string, canSeeAll: boolean, branchIds: string[]): Promise<ReturnableSale | null> {
        const rows = isUuid(saleKey)
            ? await this.prisma.$queryRaw<{ id: string }[]>`SELECT id FROM sales WHERE id = ${saleKey}::uuid`
            : await this.prisma.$queryRaw<{ id: string }[]>`SELECT id FROM sales WHERE upper(reference) = upper(${saleKey})`;
        if (rows.length === 0) return null;
        void canSeeAll; void branchIds;                      // a return can be made at ANY branch: finding the sale is not limited to the branch that sold it
        const id = rows[0].id;
        const sale = await this.prisma.$queryRaw<{ id: string; reference: string; status: string; branch_id: string; branch_name: string; sold_at: Date; business_date: string; total: string }[]>`
            SELECT s.id, s.reference, s.status, s.branch_id, b.name AS branch_name, s.sold_at, s.business_date::text AS business_date, s.total::text AS total FROM sales s JOIN branches b ON b.id = s.branch_id WHERE s.id = ${id}::uuid`;
        const lines = await this.prisma.$queryRaw<{ id: string; sku_id: string; sku_code: string; description: string; quantity: number; line_total: string; returned: number; in_custody: number }[]>`
            SELECT l.id, l.sku_id, k.sku_code, st.name || ', ' || k.size || ', ' || k.color AS description, l.quantity, l.line_total::text AS line_total,
                   COALESCE((SELECT SUM(rl.quantity) FROM return_lines rl JOIN returns r ON r.id = rl.return_id WHERE rl.sale_line_id = l.id AND r.status = 'approved'), 0)::int AS returned,
                   COALESCE((SELECT SUM(rl.quantity) FROM return_lines rl JOIN returns r ON r.id = rl.return_id WHERE rl.sale_line_id = l.id AND r.status = 'in_custody'), 0)::int AS in_custody
            FROM sale_lines l JOIN skus k ON k.id = l.sku_id JOIN styles st ON st.id = k.style_id WHERE l.sale_id = ${id}::uuid ORDER BY l.line_no`;
        const period = await returnPeriodDays(this.prisma);
        const days = daysBetween(sale[0].business_date, businessDateOf(new Date()));
        return {
            sale: { id: sale[0].id, reference: sale[0].reference, status: sale[0].status, branch: { id: sale[0].branch_id, name: sale[0].branch_name }, soldAt: sale[0].sold_at, businessDate: sale[0].business_date, total: sale[0].total },
            returnPeriodDays: period, daysSinceSale: days, withinPeriod: days <= period,
            lines: lines.map((l) => ({ saleLineId: l.id, skuId: l.sku_id, skuCode: l.sku_code, description: l.description, sold: l.quantity, returned: l.returned, inCustody: l.in_custody, returnable: l.quantity - l.returned - l.in_custody, lineTotal: l.line_total })),
        };
    }

    async create(request: CreateReturnRequest, actorId: string, key: string, requestHash: string, isManager: boolean, authorize: (receivingBranchId: string) => void): Promise<{ id: string; replayed: boolean }> {
        return this.prisma.$transaction(async (tx) => {
            const claim = await claimIdempotencyKey(tx, actorId, 'return.create', key, requestHash);
            if (claim.kind === 'replay') return { id: claim.resourceId, replayed: true };
            if (claim.kind === 'different_request') throw new ConflictError('This Idempotency-Key was already used for a different request');
            if (claim.kind === 'in_progress') throw new ConflictError('This request is already being processed');
            const branch = await tx.$queryRaw<{ kind: string; is_active: boolean }[]>`SELECT kind, is_active FROM branches WHERE id = ${request.receivingBranchId}::uuid`;
            if (branch.length === 0) throw new NotFoundError('Branch not found');
            authorize(request.receivingBranchId);
            if (branch[0].kind === 'warehouse') throw new ConflictError('Customers return goods at a branch, not at the warehouse');
            if (!branch[0].is_active) throw new ConflictError('This branch is inactive');
            // two returns of the same sale are decided one at a time: the sale row is locked
            const sale = await tx.$queryRaw<{ id: string; status: string; business_date: string; reference: string }[]>`SELECT id, status, business_date::text AS business_date, reference FROM sales WHERE id = ${request.saleId}::uuid FOR UPDATE`;
            if (sale.length === 0) throw new NotFoundError('Sale not found');
            if (sale[0].status === 'reversed' || sale[0].status === 'returned') throw new ConflictError(`${sale[0].reference} is ${sale[0].status}: nothing can be returned from it`);
            const period = await returnPeriodDays(tx);
            const days = daysBetween(sale[0].business_date, businessDateOf(new Date()));
            if (days > period) {
                if (!request.lateExceptionReason) throw new ConflictError(`This sale is ${days} days old and the return period is ${period} days: a manager has to approve an exception (lateException.reason)`);
                if (!isManager) throw new ForbiddenError('Only a manager can approve a return outside the return period');
            }
            const lines = await tx.$queryRaw<{ id: string; sku_id: string; sku_code: string; quantity: number; used: number }[]>`
                SELECT l.id, l.sku_id, k.sku_code, l.quantity,
                       COALESCE((SELECT SUM(rl.quantity) FROM return_lines rl JOIN returns r ON r.id = rl.return_id WHERE rl.sale_line_id = l.id AND r.status IN ('in_custody', 'approved')), 0)::int AS used
                FROM sale_lines l JOIN skus k ON k.id = l.sku_id WHERE l.sale_id = ${request.saleId}::uuid AND l.sku_id = ANY(${request.lines.map((x) => x.skuId)}::uuid[])`;
            const bySku = new Map(lines.map((l) => [l.sku_id, l]));
            const missing = request.lines.filter((l) => !bySku.has(l.skuId));
            if (missing.length > 0) throw new NotFoundError('A product of the return is not on that sale');
            const over = request.lines.filter((l) => l.quantity > bySku.get(l.skuId)!.quantity - bySku.get(l.skuId)!.used);
            if (over.length > 0) {
                throw new ConflictError(`More than can be returned: ${over.map((l) => `${bySku.get(l.skuId)!.sku_code} (asked ${l.quantity}, returnable ${bySku.get(l.skuId)!.quantity - bySku.get(l.skuId)!.used})`).join(', ')}`);
            }
            const created = await tx.$queryRaw<{ id: string; reference: string }[]>`
                INSERT INTO returns (sale_id, receiving_branch_id, custody, reason, note, late_exception_reason, received_by, idempotency_key_id)
                VALUES (${request.saleId}::uuid, ${request.receivingBranchId}::uuid, ${request.custody}, ${request.reason}, ${request.note}::text, ${request.lateExceptionReason}::text, ${actorId}::uuid, ${claim.keyId}::uuid) RETURNING id, reference`;
            for (const line of request.lines) {
                await tx.$executeRaw`INSERT INTO return_lines (return_id, sale_line_id, sku_id, quantity, condition) VALUES (${created[0].id}::uuid, ${bySku.get(line.skuId)!.id}::uuid, ${line.skuId}::uuid, ${line.quantity}::int, ${line.condition})`;
            }
            await writeAudit(tx, { actorId, action: 'return.receive', entityType: 'return', entityId: created[0].id, branchId: request.receivingBranchId,
                details: { reference: created[0].reference, sale: sale[0].reference, units: request.lines.reduce((n, l) => n + l.quantity, 0), custody: request.custody, late: request.lateExceptionReason } });
            await completeIdempotencyKey(tx, claim.keyId, 'return', created[0].id);
            return { id: created[0].id, replayed: false };
        }, TX);
    }

    private async lockReturn(tx: Prisma.TransactionClient, id: string, authorize: (branchId: string) => void): Promise<{ status: string; custody: string; branchId: string; saleId: string; reference: string; refundTotal: string | null }> {
        const rows = await tx.$queryRaw<{ status: string; custody: string; receiving_branch_id: string; sale_id: string; reference: string; refund_total: string | null }[]>`
            SELECT status, custody, receiving_branch_id, sale_id, reference, refund_total::text AS refund_total FROM returns WHERE id = ${id}::uuid FOR UPDATE`;
        if (rows.length === 0) throw new NotFoundError('Return not found');
        authorize(rows[0].receiving_branch_id);
        return { status: rows[0].status, custody: rows[0].custody, branchId: rows[0].receiving_branch_id, saleId: rows[0].sale_id, reference: rows[0].reference, refundTotal: rows[0].refund_total };
    }

    async takeCustody(returnId: string, actorId: string, authorize: (branchId: string) => void): Promise<string> {
        return this.prisma.$transaction(async (tx) => {
            const r = await this.lockReturn(tx, returnId, authorize);
            if (r.status !== 'in_custody') throw new ConflictError(`${r.reference} is ${r.status}`);
            if (r.custody === 'with_branch') throw new ConflictError('The goods are already with the branch');
            await tx.$executeRaw`UPDATE returns SET custody = 'with_branch' WHERE id = ${returnId}::uuid`;
            await writeAudit(tx, { actorId, action: 'return.custody', entityType: 'return', entityId: returnId, branchId: r.branchId, details: { reference: r.reference } });
            return returnId;
        }, TX);
    }

    async approve(returnId: string, reason: string | null, actorId: string, key: string, requestHash: string, authorize: (branchId: string) => void): Promise<{ id: string; replayed: boolean }> {
        return this.prisma.$transaction(async (tx) => {
            const claim = await claimIdempotencyKey(tx, actorId, 'return.approve', key, requestHash);
            if (claim.kind === 'replay') return { id: claim.resourceId, replayed: true };
            if (claim.kind === 'different_request') throw new ConflictError('This Idempotency-Key was already used for a different request');
            if (claim.kind === 'in_progress') throw new ConflictError('This request is already being processed');
            const r = await this.lockReturn(tx, returnId, authorize);
            if (r.status !== 'in_custody') throw new ConflictError(`${r.reference} is ${r.status}: only a return in custody can be approved`);
            if (r.custody !== 'with_branch') throw new ConflictError('The goods are still with the customer: take them into custody first');
            await tx.$queryRaw`SELECT id FROM sales WHERE id = ${r.saleId}::uuid FOR UPDATE`;           // approvals of the same sale are done one at a time, so the refunds never add up to more than was paid
            const lines = await tx.$queryRaw<{ id: string; sale_line_id: string; sku_id: string; quantity: number; line_total: string; sold: number }[]>`
                SELECT l.id, l.sale_line_id, l.sku_id, l.quantity, sl.line_total::text AS line_total, sl.quantity AS sold FROM return_lines l JOIN sale_lines sl ON sl.id = l.sale_line_id WHERE l.return_id = ${returnId}::uuid ORDER BY l.sku_id`;
            let total = 0;
            for (const line of lines) {
                const before = await tx.$queryRaw<{ qty: number; value: string }[]>`
                    SELECT COALESCE(SUM(rl.quantity), 0)::int AS qty, COALESCE(SUM(rl.refund_value), 0)::text AS value FROM return_lines rl JOIN returns x ON x.id = rl.return_id WHERE rl.sale_line_id = ${line.sale_line_id}::uuid AND x.status = 'approved'`;
                const value = refundValueCents(cents(line.line_total), line.sold, before[0].qty, cents(before[0].value), line.quantity);
                total += value;
                await tx.$executeRaw`UPDATE return_lines SET refund_value = ${formatCents(value)}::numeric WHERE id = ${line.id}::uuid`;
                // the goods enter the business stock ON HOLD, once; refund approval does not release them for sale
                await lockBuckets(tx, r.branchId, line.sku_id, ['non_sellable']);
                await moveStock(tx, { skuId: line.sku_id, branchId: r.branchId, bucket: 'non_sellable', delta: line.quantity, type: 'return_approval', returnId, actorId, keyId: claim.keyId, reason: `Return ${r.reference} approved` });
            }
            await tx.$executeRaw`UPDATE returns SET status = 'approved', decided_by = ${actorId}::uuid, decided_at = now(), decision_reason = ${reason}::text, refund_total = ${formatCents(total)}::numeric WHERE id = ${returnId}::uuid`;
            await writeAudit(tx, { actorId, action: 'return.approve', entityType: 'return', entityId: returnId, branchId: r.branchId, details: { reference: r.reference, refundTotal: formatCents(total), units: lines.reduce((n, l) => n + l.quantity, 0), reason } });
            await completeIdempotencyKey(tx, claim.keyId, 'return', returnId);
            return { id: returnId, replayed: false };
        }, TX);
    }

    async reject(returnId: string, reason: string, actorId: string, authorize: (branchId: string) => void): Promise<string> {
        return this.prisma.$transaction(async (tx) => {
            const r = await this.lockReturn(tx, returnId, authorize);
            if (r.status !== 'in_custody') throw new ConflictError(`${r.reference} is ${r.status}: only a return in custody can be rejected`);
            await tx.$executeRaw`UPDATE returns SET status = 'rejected', decided_by = ${actorId}::uuid, decided_at = now(), decision_reason = ${reason} WHERE id = ${returnId}::uuid`;
            await writeAudit(tx, { actorId, action: 'return.reject', entityType: 'return', entityId: returnId, branchId: r.branchId, details: { reference: r.reference, reason } });
            return returnId;
        }, TX);
    }

    async handback(returnId: string, recipient: string, actorId: string, authorize: (branchId: string) => void): Promise<string> {
        return this.prisma.$transaction(async (tx) => {
            const r = await this.lockReturn(tx, returnId, authorize);
            if (r.status !== 'rejected') throw new ConflictError(`${r.reference} is ${r.status}: only a rejected return awaits handback`);
            await tx.$executeRaw`UPDATE returns SET status = 'handed_back', handed_back_to = ${recipient}, handed_back_by = ${actorId}::uuid, handed_back_at = now() WHERE id = ${returnId}::uuid`;
            await writeAudit(tx, { actorId, action: 'return.handback', entityType: 'return', entityId: returnId, branchId: r.branchId, details: { reference: r.reference, recipient } });
            return returnId;
        }, TX);
    }

    // an exchange: the replacement sale, made at the same branch after the goods were received, is linked to the approved return; the net amount is kept
    async linkExchange(returnId: string, saleId: string, actorId: string, authorize: (branchId: string) => void): Promise<string> {
        return this.prisma.$transaction(async (tx) => {
            const r = await this.lockReturn(tx, returnId, authorize);
            if (r.status !== 'approved' || r.refundTotal === null) throw new ConflictError(`${r.reference} is ${r.status}: an exchange is made on an approved return`);
            const existing = await tx.$queryRaw<{ exchange_sale_id: string | null; received_at: Date }[]>`SELECT exchange_sale_id, received_at FROM returns WHERE id = ${returnId}::uuid`;
            if (existing[0].exchange_sale_id !== null) throw new ConflictError('This return is already linked to an exchange sale');
            const sale = await tx.$queryRaw<{ id: string; reference: string; status: string; branch_id: string; sold_at: Date; total: string }[]>`SELECT id, reference, status, branch_id, sold_at, total::text AS total FROM sales WHERE id = ${saleId}::uuid FOR UPDATE`;
            if (sale.length === 0) throw new NotFoundError('Sale not found');
            if (sale[0].status === 'reversed') throw new ConflictError(`${sale[0].reference} is reversed`);
            if (sale[0].id === r.saleId) throw new ConflictError('The exchange sale must be a NEW sale, not the sale being returned');
            if (sale[0].branch_id !== r.branchId) throw new ConflictError('The replacement is sold at the branch that took the goods back');
            if (sale[0].sold_at < existing[0].received_at) throw new ConflictError('The replacement sale was made before the goods were received');
            const taken = await tx.$queryRaw<{ reference: string }[]>`SELECT reference FROM returns WHERE exchange_sale_id = ${saleId}::uuid`;
            if (taken.length > 0) throw new ConflictError(`${sale[0].reference} is already the exchange of ${taken[0].reference}`);
            const net = cents(sale[0].total) - cents(r.refundTotal);
            await tx.$executeRaw`UPDATE returns SET exchange_sale_id = ${saleId}::uuid, exchange_net = ${formatCents(net)}::numeric, exchange_linked_by = ${actorId}::uuid, exchange_linked_at = now() WHERE id = ${returnId}::uuid`;
            await writeAudit(tx, { actorId, action: 'return.exchange', entityType: 'return', entityId: returnId, branchId: r.branchId, details: { reference: r.reference, sale: sale[0].reference, saleTotal: sale[0].total, refundTotal: r.refundTotal, net: formatCents(net) } });
            return returnId;
        }, TX);
    }

    // the manager releases returned goods from the hold to sale, separately from the approval and from the refund
    async release(returnId: string, requested: { returnLineId: string; quantity: number }[] | null, actorId: string, key: string, requestHash: string, authorize: (branchId: string) => void): Promise<{ id: string; replayed: boolean }> {
        return this.prisma.$transaction(async (tx) => {
            const claim = await claimIdempotencyKey(tx, actorId, 'return.release', key, requestHash);
            if (claim.kind === 'replay') return { id: claim.resourceId, replayed: true };
            if (claim.kind === 'different_request') throw new ConflictError('This Idempotency-Key was already used for a different request');
            if (claim.kind === 'in_progress') throw new ConflictError('This request is already being processed');
            const r = await this.lockReturn(tx, returnId, authorize);
            if (r.status !== 'approved') throw new ConflictError(`${r.reference} is ${r.status}: only the goods of an approved return are on hold`);
            const lines = await tx.$queryRaw<{ id: string; sku_id: string; sku_code: string; quantity: number; released_qty: number }[]>`
                SELECT l.id, l.sku_id, k.sku_code, l.quantity, l.released_qty FROM return_lines l JOIN skus k ON k.id = l.sku_id WHERE l.return_id = ${returnId}::uuid ORDER BY l.sku_id FOR UPDATE OF l`;
            const wanted = requested === null ? lines.map((l) => ({ returnLineId: l.id, quantity: l.quantity - l.released_qty })).filter((l) => l.quantity > 0)
                : requested;
            if (wanted.length === 0) throw new ConflictError('Nothing is left on hold from this return');
            for (const w of wanted) {
                const line = lines.find((l) => l.id === w.returnLineId);
                if (!line) throw new NotFoundError('A line to release is not a line of this return');
                if (w.quantity > line.quantity - line.released_qty) throw new ConflictError(`${line.sku_code}: only ${line.quantity - line.released_qty} left on hold from this return, ${w.quantity} asked`);
            }
            const sorted = [...wanted].sort((a, b) => lines.find((l) => l.id === a.returnLineId)!.sku_id.localeCompare(lines.find((l) => l.id === b.returnLineId)!.sku_id));
            const short: string[] = [];
            for (const w of sorted) {
                const line = lines.find((l) => l.id === w.returnLineId)!;
                const held = await lockBuckets(tx, r.branchId, line.sku_id, ['sellable', 'non_sellable']);
                if ((held.get('non_sellable') ?? 0) < w.quantity) short.push(`${line.sku_code} (on hold ${held.get('non_sellable') ?? 0}, asked ${w.quantity})`);
            }
            if (short.length > 0) throw new ConflictError(`Not enough on hold at the branch (some may have been disposed of): ${short.join(', ')}`);
            for (const w of sorted) {
                const line = lines.find((l) => l.id === w.returnLineId)!;
                await moveStock(tx, { skuId: line.sku_id, branchId: r.branchId, bucket: 'non_sellable', delta: -w.quantity, type: 'return_release', returnId, actorId, keyId: claim.keyId, reason: `Return ${r.reference} released to sale` });
                await moveStock(tx, { skuId: line.sku_id, branchId: r.branchId, bucket: 'sellable', delta: w.quantity, type: 'return_release', returnId, actorId, keyId: claim.keyId, reason: `Return ${r.reference} released to sale` });
                await tx.$executeRaw`UPDATE return_lines SET released_qty = released_qty + ${w.quantity}::int WHERE id = ${w.returnLineId}::uuid`;
            }
            await writeAudit(tx, { actorId, action: 'return.release', entityType: 'return', entityId: returnId, branchId: r.branchId, details: { reference: r.reference, units: wanted.reduce((n, w) => n + w.quantity, 0) } });
            await completeIdempotencyKey(tx, claim.keyId, 'return', returnId);
            return { id: returnId, replayed: false };
        }, TX);
    }

    async payRefund(returnId: string, payment: { method: 'cash' | 'whish'; amountCents: number; recipient: string; reference: string | null }, actorId: string, key: string, requestHash: string, authorize: (branchId: string) => void): Promise<{ id: string; replayed: boolean }> {
        return this.prisma.$transaction(async (tx) => {
            const claim = await claimIdempotencyKey(tx, actorId, 'return.refund', key, requestHash);
            if (claim.kind === 'replay') return { id: claim.resourceId, replayed: true };
            if (claim.kind === 'different_request') throw new ConflictError('This Idempotency-Key was already used for a different request');
            if (claim.kind === 'in_progress') throw new ConflictError('This request is already being processed');
            const r = await this.lockReturn(tx, returnId, authorize);
            if (r.status !== 'approved' || r.refundTotal === null) throw new ConflictError(`${r.reference} is ${r.status}: a refund is paid only for an approved return`);
            const paid = await tx.$queryRaw<{ paid: string }[]>`SELECT COALESCE(SUM(amount), 0)::text AS paid FROM return_refund_payments WHERE return_id = ${returnId}::uuid`;
            const outstanding = cents(r.refundTotal) - cents(paid[0].paid);
            if (payment.amountCents > outstanding) throw new ConflictError(`Only ${formatCents(outstanding)} is left to refund for ${r.reference}: you cannot pay ${formatCents(payment.amountCents)}`);
            // a cash refund comes out of the drawer of the branch that pays it (the session is locked FOR SHARE: a closing waits for it)
            let sessionId: string | null = null;
            if (payment.method === 'cash') {
                const setting = await tx.$queryRaw<{ value: unknown }[]>`SELECT value FROM settings WHERE key = 'requireOpenCashSession'`;
                const open = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM cash_sessions WHERE branch_id = ${r.branchId}::uuid AND status = 'open' FOR SHARE`;
                sessionId = open[0]?.id ?? null;
                if (sessionId === null && setting[0]?.value === true) throw new ConflictError('This branch has no open cash session: open one before paying a cash refund');
            }
            const rows = await tx.$queryRaw<{ id: string }[]>`
                INSERT INTO return_refund_payments (return_id, method, amount, recipient, reference, cash_session_id, paid_by)
                VALUES (${returnId}::uuid, ${payment.method}, ${formatCents(payment.amountCents)}::numeric, ${payment.recipient}, ${payment.reference}::text, ${sessionId}::uuid, ${actorId}::uuid) RETURNING id`;
            await writeAudit(tx, { actorId, action: 'return.refund', entityType: 'return', entityId: returnId, branchId: r.branchId, details: { reference: r.reference, method: payment.method, amount: formatCents(payment.amountCents), recipient: payment.recipient, outstandingAfter: formatCents(outstanding - payment.amountCents) } });
            await completeIdempotencyKey(tx, claim.keyId, 'return', returnId);
            return { id: rows[0].id, replayed: false };
        }, TX);
    }
}
