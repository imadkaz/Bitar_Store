import { Prisma, PrismaClient } from '../generated/prisma/client';
import { CorrectionField, expectedCashCents, isLateClosing } from '../models/CashSession.model';
import { formatCents } from '../models/Money';
import { BUSINESS_TIME_ZONE } from '../utils/businessDate';
import { ConflictError } from '../utils/exeptions/ConflictError';
import { NotFoundError } from '../utils/exeptions/NotFoundError';
import { ValidationError } from '../utils/exeptions/ValidationError';
import { writeAudit } from './audit';
import { claimIdempotencyKey, completeIdempotencyKey } from './idempotency';
import { CashSessionListFilter, CashSessionSummary, CashSessionView, ICashSessionRepository } from './interfaces/ICashSessionRepository';

type Q = { $queryRaw: PrismaClient['$queryRaw'] };
const TX = { maxWait: 10_000, timeout: 30_000 };
const cents = (decimal: string | null): number => (decimal === null ? 0 : Math.round(Number(decimal) * 100));
const person = (id: string | null, name: string | null) => ({ id: id as string, name });

interface Row {
    id: string; reference: string; branch_id: string; branch_code: string; branch_name: string; status: 'open' | 'closed'; opened_by: string; opener: string | null; opened_at: Date;
    opening_cash: string; expected_opening: string | null; opening_note: string | null; responsible_user_id: string; responsible: string | null; closed_by: string | null; closer: string | null;
    closed_at: Date | null; expected_cash: string | null; counted_cash: string | null; difference: string | null; difference_note: string | null; cash_removed: string | null; cash_left: string | null;
    late_closed: boolean; review_status: 'none' | 'flagged' | 'reviewed'; reviewed_by: string | null; reviewer: string | null; reviewed_at: Date | null; review_note: string | null;
}

async function loadSession(q: Q, id: string): Promise<CashSessionView | null> {
    const rows = await q.$queryRaw<Row[]>`
        SELECT s.id, s.reference, s.branch_id, b.code AS branch_code, b.name AS branch_name, s.status, s.opened_by, ou.full_name AS opener, s.opened_at,
               s.opening_cash::text AS opening_cash, s.expected_opening::text AS expected_opening, s.opening_note, s.responsible_user_id, ru.full_name AS responsible,
               s.closed_by, cu.full_name AS closer, s.closed_at, s.expected_cash::text AS expected_cash, s.counted_cash::text AS counted_cash, s.difference::text AS difference,
               s.difference_note, s.cash_removed::text AS cash_removed, s.cash_left::text AS cash_left, s.late_closed, s.review_status, s.reviewed_by, rv.full_name AS reviewer, s.reviewed_at, s.review_note
        FROM cash_sessions s JOIN branches b ON b.id = s.branch_id
        LEFT JOIN users ou ON ou.id = s.opened_by LEFT JOIN users ru ON ru.id = s.responsible_user_id LEFT JOIN users cu ON cu.id = s.closed_by LEFT JOIN users rv ON rv.id = s.reviewed_by
        WHERE s.id = ${id}::uuid`;
    if (rows.length === 0) return null;
    const s = rows[0];

    const sales = await q.$queryRaw<{ n: number; total: string }[]>`SELECT COUNT(*)::int AS n, COALESCE(SUM(total), 0)::numeric(14,2)::text AS total FROM sales WHERE cash_session_id = ${id}::uuid`;
    const paid = await q.$queryRaw<{ method: string; amount: string }[]>`
        SELECT p.method, COALESCE(SUM(p.amount), 0)::text AS amount FROM sale_payments p JOIN sales x ON x.id = p.sale_id WHERE x.cash_session_id = ${id}::uuid GROUP BY p.method`;
    const lbp = await q.$queryRaw<{ paid: string; received: string; change: string }[]>`
        SELECT COALESCE(SUM(p.amount) FILTER (WHERE p.currency = 'LBP'), 0)::numeric(14,2)::text AS paid, COALESCE(SUM(p.lbp_amount), 0)::text AS received, COALESCE(SUM(p.change_lbp), 0)::text AS change
        FROM sale_payments p JOIN sales x ON x.id = p.sale_id WHERE x.cash_session_id = ${id}::uuid`;
    const byUser = await q.$queryRaw<{ sold_by: string; name: string | null; n: number; total: string; cash: string; whish: string }[]>`
        SELECT x.sold_by, u.full_name AS name, COUNT(*)::int AS n, SUM(x.total)::text AS total,
               COALESCE(SUM((SELECT SUM(p.amount) FROM sale_payments p WHERE p.sale_id = x.id AND p.method = 'cash')), 0)::numeric(14,2)::text AS cash,
               COALESCE(SUM((SELECT SUM(p.amount) FROM sale_payments p WHERE p.sale_id = x.id AND p.method = 'whish')), 0)::numeric(14,2)::text AS whish
        FROM sales x LEFT JOIN users u ON u.id = x.sold_by WHERE x.cash_session_id = ${id}::uuid GROUP BY x.sold_by, u.full_name ORDER BY u.full_name NULLS LAST, x.sold_by`;
    const movements = await q.$queryRaw<{ id: string; direction: 'in' | 'out'; amount: string; reason: string; created_by: string; who: string | null; created_at: Date }[]>`
        SELECT m.id, m.direction, m.amount::text AS amount, m.reason, m.created_by, u.full_name AS who, m.created_at FROM cash_movements m LEFT JOIN users u ON u.id = m.created_by
        WHERE m.session_id = ${id}::uuid ORDER BY m.created_at, m.id`;
    const handovers = await q.$queryRaw<{ id: string; outgoing_user_id: string; fromname: string | null; incoming_user_id: string; toname: string | null; counted_cash: string; expected_cash: string; difference: string; note: string | null; created_at: Date }[]>`
        SELECT h.id, h.outgoing_user_id, fu.full_name AS fromname, h.incoming_user_id, tu.full_name AS toname, h.counted_cash::text AS counted_cash, h.expected_cash::text AS expected_cash,
               h.difference::text AS difference, h.note, h.created_at
        FROM cash_handovers h LEFT JOIN users fu ON fu.id = h.outgoing_user_id LEFT JOIN users tu ON tu.id = h.incoming_user_id WHERE h.session_id = ${id}::uuid ORDER BY h.created_at, h.id`;
    const corrections = await q.$queryRaw<{ id: string; field: CorrectionField; value_before: string; value_after: string; reason: string; corrected_by: string; who: string | null; created_at: Date }[]>`
        SELECT c.id, c.field, c.value_before::text AS value_before, c.value_after::text AS value_after, c.reason, c.corrected_by, u.full_name AS who, c.created_at
        FROM cash_session_corrections c LEFT JOIN users u ON u.id = c.corrected_by WHERE c.session_id = ${id}::uuid ORDER BY c.created_at, c.id`;

    const cashPayments = cents(paid.find((p) => p.method === 'cash')?.amount ?? '0');
    const whishPayments = cents(paid.find((p) => p.method === 'whish')?.amount ?? '0');
    const cashIn = movements.filter((m) => m.direction === 'in').reduce((n, m) => n + cents(m.amount), 0);
    const cashOut = movements.filter((m) => m.direction === 'out').reduce((n, m) => n + cents(m.amount), 0);
    const expected = expectedCashCents({ openingCents: cents(s.opening_cash), cashPaymentsCents: cashPayments, cashInCents: cashIn, cashOutCents: cashOut });

    // the closing with the manager's corrections applied (the latest correction of each field wins; the closing itself is never changed)
    const latest = (field: CorrectionField, original: string | null) => cents(corrections.filter((c) => c.field === field).at(-1)?.value_after ?? original);
    let effective: CashSessionView['effective'] = null;
    if (s.status === 'closed') {
        const opening = latest('opening_cash', s.opening_cash), counted = latest('counted_cash', s.counted_cash), removed = latest('cash_removed', s.cash_removed);
        const expectedNow = expectedCashCents({ openingCents: opening, cashPaymentsCents: cashPayments, cashInCents: cashIn, cashOutCents: cashOut });
        effective = { openingCash: formatCents(opening), countedCash: formatCents(counted), cashRemoved: formatCents(removed), cashLeft: formatCents(counted - removed), expectedCash: formatCents(expectedNow), difference: formatCents(counted - expectedNow) };
    }
    return {
        id: s.id, reference: s.reference, branch: { id: s.branch_id, code: s.branch_code, name: s.branch_name }, status: s.status, openedBy: person(s.opened_by, s.opener), openedAt: s.opened_at,
        openingCash: s.opening_cash, expectedOpening: s.expected_opening, openingNote: s.opening_note, responsible: person(s.responsible_user_id, s.responsible),
        totals: { salesCount: sales[0].n, salesTotal: sales[0].total, cashPayments: formatCents(cashPayments), whishPayments: formatCents(whishPayments), paidInLbp: lbp[0].paid, lbpReceived: Number(lbp[0].received), lbpChangeGiven: Number(lbp[0].change), cashIn: formatCents(cashIn), cashOut: formatCents(cashOut), expectedCash: formatCents(expected) },
        byUser: byUser.map((u) => ({ user: person(u.sold_by, u.name), salesCount: u.n, total: u.total, cash: u.cash, whish: u.whish })),
        movements: movements.map((m) => ({ id: m.id, direction: m.direction, amount: m.amount, reason: m.reason, by: person(m.created_by, m.who), at: m.created_at })),
        handovers: handovers.map((h) => ({ id: h.id, from: person(h.outgoing_user_id, h.fromname), to: person(h.incoming_user_id, h.toname), countedCash: h.counted_cash, expectedCash: h.expected_cash, difference: h.difference, note: h.note, at: h.created_at })),
        corrections: corrections.map((c) => ({ id: c.id, field: c.field, before: c.value_before, after: c.value_after, reason: c.reason, by: person(c.corrected_by, c.who), at: c.created_at })),
        closing: s.status === 'closed' ? { closedBy: person(s.closed_by, s.closer), closedAt: s.closed_at as Date, expectedCash: s.expected_cash as string, countedCash: s.counted_cash as string, difference: s.difference as string, differenceNote: s.difference_note, cashRemoved: s.cash_removed as string, cashLeft: s.cash_left as string, lateClosed: s.late_closed } : null,
        effective,
        review: { status: s.review_status, by: s.reviewed_by ? person(s.reviewed_by, s.reviewer) : null, at: s.reviewed_at, note: s.review_note },
    };
}

export class CashSessionRepository implements ICashSessionRepository {
    constructor(private readonly prisma: PrismaClient) {}

    findById(id: string) { return loadSession(this.prisma, id); }

    async findOpen(branchId: string): Promise<CashSessionView | null> {
        const rows = await this.prisma.$queryRaw<{ id: string }[]>`SELECT id FROM cash_sessions WHERE branch_id = ${branchId}::uuid AND status = 'open'`;
        return rows[0] ? loadSession(this.prisma, rows[0].id) : null;
    }

    async branchOf(sessionId: string): Promise<string | null> {
        const rows = await this.prisma.$queryRaw<{ branch_id: string }[]>`SELECT branch_id FROM cash_sessions WHERE id = ${sessionId}::uuid`;
        return rows[0]?.branch_id ?? null;
    }

    async list(filter: CashSessionListFilter): Promise<{ items: CashSessionSummary[]; total: number }> {
        if (filter.branchIds !== null && filter.branchIds.length === 0) return { items: [], total: 0 };
        const scope = filter.branchIds === null ? Prisma.empty : Prisma.sql`AND s.branch_id IN (${Prisma.join(filter.branchIds.map((id) => Prisma.sql`${id}::uuid`))})`;
        const branch = filter.branchId ? Prisma.sql`AND s.branch_id = ${filter.branchId}::uuid` : Prisma.empty;
        const status = filter.status ? Prisma.sql`AND s.status = ${filter.status}` : Prisma.empty;
        const review = filter.review ? Prisma.sql`AND s.review_status = ${filter.review}` : Prisma.empty;
        const from = filter.from ? Prisma.sql`AND s.opened_at >= (${filter.from}::date)::timestamp AT TIME ZONE ${BUSINESS_TIME_ZONE}` : Prisma.empty;
        const to = filter.to ? Prisma.sql`AND s.opened_at < ((${filter.to}::date + 1))::timestamp AT TIME ZONE ${BUSINESS_TIME_ZONE}` : Prisma.empty;
        const where = Prisma.sql`TRUE ${scope} ${branch} ${status} ${review} ${from} ${to}`;
        const [rows, count] = await Promise.all([
            this.prisma.$queryRaw<{ id: string; reference: string; branch_id: string; code: string; name: string; status: 'open' | 'closed'; opened_by: string; opener: string | null; opened_at: Date; responsible_user_id: string; responsible: string | null; closed_at: Date | null; difference: string | null; late_closed: boolean; review_status: 'none' | 'flagged' | 'reviewed' }[]>(Prisma.sql`
                SELECT s.id, s.reference, s.branch_id, b.code, b.name, s.status, s.opened_by, ou.full_name AS opener, s.opened_at, s.responsible_user_id, ru.full_name AS responsible, s.closed_at,
                       s.difference::text AS difference, s.late_closed, s.review_status
                FROM cash_sessions s JOIN branches b ON b.id = s.branch_id LEFT JOIN users ou ON ou.id = s.opened_by LEFT JOIN users ru ON ru.id = s.responsible_user_id
                WHERE ${where} ORDER BY s.opened_at DESC, s.id DESC LIMIT ${filter.limit} OFFSET ${filter.offset}`),
            this.prisma.$queryRaw<{ n: number }[]>(Prisma.sql`SELECT COUNT(*)::int AS n FROM cash_sessions s WHERE ${where}`),
        ]);
        return {
            items: rows.map((r) => ({ id: r.id, reference: r.reference, branch: { id: r.branch_id, code: r.code, name: r.name }, status: r.status, openedBy: person(r.opened_by, r.opener), openedAt: r.opened_at,
                responsible: person(r.responsible_user_id, r.responsible), closedAt: r.closed_at, difference: r.difference, lateClosed: r.late_closed, reviewStatus: r.review_status })),
            total: count[0].n,
        };
    }

    async open(input: { branchId: string; openingCents: number; note: string | null }, actorId: string): Promise<string> {
        try {
            return await this.prisma.$transaction(async (tx) => {
                // what the last closed session left in the drawer: the new count is checked against it (a difference is kept, not refused)
                const previous = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM cash_sessions WHERE branch_id = ${input.branchId}::uuid AND status = 'closed' ORDER BY closed_at DESC, id DESC LIMIT 1`;
                const left = previous[0] ? (await loadSession(tx, previous[0].id))!.effective!.cashLeft : null;
                const rows = await tx.$queryRaw<{ id: string; reference: string }[]>`
                    INSERT INTO cash_sessions (branch_id, opened_by, responsible_user_id, opening_cash, expected_opening, opening_note)
                    VALUES (${input.branchId}::uuid, ${actorId}::uuid, ${actorId}::uuid, ${formatCents(input.openingCents)}::numeric, ${left}::numeric, ${input.note}::text) RETURNING id, reference`;
                await writeAudit(tx, { actorId, action: 'cash_session.open', entityType: 'cash_session', entityId: rows[0].id, branchId: input.branchId, details: { reference: rows[0].reference, openingCash: formatCents(input.openingCents), expectedOpening: left } });
                return rows[0].id;
            }, TX);
        } catch (error) {
            // a raw query reports the database's own code (23505) with the name of the index, not Prisma's P2002
            if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === 'P2002' || String(error.message).includes('ux_cash_sessions_one_open'))) {
                const open = await this.findOpen(input.branchId);
                throw new ConflictError(`This branch already has an open cash session${open ? `: ${open.reference}` : ''}`);
            }
            throw error;
        }
    }

    // the session row is locked FOR UPDATE: a sale in progress holds it FOR SHARE, so a movement, a handover or a closing waits for it and never misses it
    private async lockOpen(tx: Prisma.TransactionClient, sessionId: string, authorize: (branchId: string) => void): Promise<{ branchId: string; responsibleId: string; openedAt: Date }> {
        const rows = await tx.$queryRaw<{ branch_id: string; status: string; responsible_user_id: string; opened_at: Date; reference: string }[]>`SELECT branch_id, status, responsible_user_id, opened_at, reference FROM cash_sessions WHERE id = ${sessionId}::uuid FOR UPDATE`;
        if (rows.length === 0) throw new NotFoundError('Cash session not found');
        authorize(rows[0].branch_id);
        if (rows[0].status !== 'open') throw new ConflictError(`${rows[0].reference} is closed`);
        return { branchId: rows[0].branch_id, responsibleId: rows[0].responsible_user_id, openedAt: rows[0].opened_at };
    }

    async addMovement(input: { sessionId: string; direction: 'in' | 'out'; amountCents: number; reason: string; key: string; requestHash: string }, actorId: string, authorize: (branchId: string) => void): Promise<{ id: string; replayed: boolean }> {
        return this.prisma.$transaction(async (tx) => {
            const claim = await claimIdempotencyKey(tx, actorId, 'cash_movement.create', input.key, input.requestHash);
            if (claim.kind === 'replay') return { id: claim.resourceId, replayed: true };
            if (claim.kind === 'different_request') throw new ConflictError('This Idempotency-Key was already used for a different request');
            if (claim.kind === 'in_progress') throw new ConflictError('This request is already being processed');
            const locked = await this.lockOpen(tx, input.sessionId, authorize);
            if (input.direction === 'out') {
                // cash cannot be taken out that is not in the drawer
                const view = (await loadSession(tx, input.sessionId))!;
                if (input.amountCents > cents(view.totals.expectedCash)) throw new ConflictError(`Only ${view.totals.expectedCash} is expected in the drawer: you cannot take out ${formatCents(input.amountCents)}`);
            }
            const rows = await tx.$queryRaw<{ id: string }[]>`
                INSERT INTO cash_movements (session_id, direction, amount, reason, created_by) VALUES (${input.sessionId}::uuid, ${input.direction}, ${formatCents(input.amountCents)}::numeric, ${input.reason}, ${actorId}::uuid) RETURNING id`;
            await writeAudit(tx, { actorId, action: 'cash_movement.create', entityType: 'cash_session', entityId: input.sessionId, branchId: locked.branchId, details: { direction: input.direction, amount: formatCents(input.amountCents), reason: input.reason } });
            await completeIdempotencyKey(tx, claim.keyId, 'cash_session', input.sessionId);
            return { id: rows[0].id, replayed: false };
        }, TX);
    }

    async handover(input: { sessionId: string; countedCents: number; note: string | null; key: string; requestHash: string }, incomingId: string, authorize: (branchId: string) => void): Promise<{ id: string; replayed: boolean }> {
        return this.prisma.$transaction(async (tx) => {
            const claim = await claimIdempotencyKey(tx, incomingId, 'cash_handover.create', input.key, input.requestHash);
            if (claim.kind === 'replay') return { id: claim.resourceId, replayed: true };
            if (claim.kind === 'different_request') throw new ConflictError('This Idempotency-Key was already used for a different request');
            if (claim.kind === 'in_progress') throw new ConflictError('This request is already being processed');
            const locked = await this.lockOpen(tx, input.sessionId, authorize);
            if (locked.responsibleId === incomingId) throw new ConflictError('You already have this drawer');
            const view = (await loadSession(tx, input.sessionId))!;
            const expected = cents(view.totals.expectedCash);
            const difference = input.countedCents - expected;
            if (difference !== 0 && input.note === null) throw new ValidationError(`The count differs from the expected cash by ${formatCents(difference)}: a note explaining it is required`);
            const rows = await tx.$queryRaw<{ id: string }[]>`
                INSERT INTO cash_handovers (session_id, outgoing_user_id, incoming_user_id, counted_cash, expected_cash, difference, note)
                VALUES (${input.sessionId}::uuid, ${locked.responsibleId}::uuid, ${incomingId}::uuid, ${formatCents(input.countedCents)}::numeric, ${formatCents(expected)}::numeric, ${formatCents(difference)}::numeric, ${input.note}::text) RETURNING id`;
            await tx.$executeRaw`UPDATE cash_sessions SET responsible_user_id = ${incomingId}::uuid WHERE id = ${input.sessionId}::uuid`;
            // a difference at a handover stays flagged for the manager, the session goes on
            if (difference !== 0) await tx.$executeRaw`UPDATE cash_sessions SET review_status = 'flagged' WHERE id = ${input.sessionId}::uuid AND review_status = 'none'`;
            await writeAudit(tx, { actorId: incomingId, action: 'cash_handover.create', entityType: 'cash_session', entityId: input.sessionId, branchId: locked.branchId, details: { from: locked.responsibleId, to: incomingId, counted: formatCents(input.countedCents), expected: formatCents(expected), difference: formatCents(difference) } });
            await completeIdempotencyKey(tx, claim.keyId, 'cash_session', input.sessionId);
            return { id: rows[0].id, replayed: false };
        }, TX);
    }

    async close(input: { sessionId: string; countedCents: number; removedCents: number; differenceNote: string | null }, actorId: string, authorize: (branchId: string) => void): Promise<string> {
        return this.prisma.$transaction(async (tx) => {
            const locked = await this.lockOpen(tx, input.sessionId, authorize);
            const view = (await loadSession(tx, input.sessionId))!;
            const expected = cents(view.totals.expectedCash);
            const difference = input.countedCents - expected;
            if (difference !== 0 && input.differenceNote === null) throw new ValidationError(`The count differs from the expected cash (${view.totals.expectedCash}) by ${formatCents(difference)}: differenceNote explaining it is required`);
            const now = new Date();
            const late = isLateClosing(locked.openedAt, now);
            await tx.$executeRaw`
                UPDATE cash_sessions SET status = 'closed', closed_by = ${actorId}::uuid, closed_at = ${now}, expected_cash = ${formatCents(expected)}::numeric, counted_cash = ${formatCents(input.countedCents)}::numeric,
                    difference = ${formatCents(difference)}::numeric, difference_note = ${difference === 0 ? null : input.differenceNote}::text, cash_removed = ${formatCents(input.removedCents)}::numeric,
                    cash_left = ${formatCents(input.countedCents - input.removedCents)}::numeric, late_closed = ${late},
                    review_status = CASE WHEN ${difference !== 0 || late} OR review_status = 'flagged' THEN 'flagged' ELSE 'none' END
                WHERE id = ${input.sessionId}::uuid`;
            await writeAudit(tx, { actorId, action: 'cash_session.close', entityType: 'cash_session', entityId: input.sessionId, branchId: locked.branchId,
                details: { expected: formatCents(expected), counted: formatCents(input.countedCents), difference: formatCents(difference), removed: formatCents(input.removedCents), left: formatCents(input.countedCents - input.removedCents), late } });
            return input.sessionId;
        }, TX);
    }

    async correct(input: { sessionId: string; field: CorrectionField; valueCents: number; reason: string }, actorId: string, authorize: (branchId: string) => void): Promise<string> {
        return this.prisma.$transaction(async (tx) => {
            const rows = await tx.$queryRaw<{ branch_id: string; status: string; reference: string }[]>`SELECT branch_id, status, reference FROM cash_sessions WHERE id = ${input.sessionId}::uuid FOR UPDATE`;
            if (rows.length === 0) throw new NotFoundError('Cash session not found');
            authorize(rows[0].branch_id);
            if (rows[0].status !== 'closed') throw new ConflictError(`${rows[0].reference} is still open: close it first (a correction is for a closed session)`);
            const view = (await loadSession(tx, input.sessionId))!;
            const current = cents(input.field === 'opening_cash' ? view.effective!.openingCash : input.field === 'counted_cash' ? view.effective!.countedCash : view.effective!.cashRemoved);
            if (current === input.valueCents) throw new ConflictError('The value is already this one');
            const counted = input.field === 'counted_cash' ? input.valueCents : cents(view.effective!.countedCash);
            const removed = input.field === 'cash_removed' ? input.valueCents : cents(view.effective!.cashRemoved);
            if (removed > counted) throw new ConflictError('The cash taken out cannot be more than the cash counted');
            await tx.$executeRaw`
                INSERT INTO cash_session_corrections (session_id, field, value_before, value_after, reason, corrected_by)
                VALUES (${input.sessionId}::uuid, ${input.field}, ${formatCents(current)}::numeric, ${formatCents(input.valueCents)}::numeric, ${input.reason}, ${actorId}::uuid)`;
            // the correction is kept for the manager's review
            await tx.$executeRaw`UPDATE cash_sessions SET review_status = 'flagged', reviewed_by = NULL, reviewed_at = NULL, review_note = NULL WHERE id = ${input.sessionId}::uuid`;
            await writeAudit(tx, { actorId, action: 'cash_session.correct', entityType: 'cash_session', entityId: input.sessionId, branchId: rows[0].branch_id, details: { field: input.field, before: formatCents(current), after: formatCents(input.valueCents), reason: input.reason } });
            return input.sessionId;
        }, TX);
    }

    async review(input: { sessionId: string; note: string | null }, actorId: string, authorize: (branchId: string) => void): Promise<string> {
        return this.prisma.$transaction(async (tx) => {
            const rows = await tx.$queryRaw<{ branch_id: string; status: string; reference: string; review_status: string }[]>`SELECT branch_id, status, reference, review_status FROM cash_sessions WHERE id = ${input.sessionId}::uuid FOR UPDATE`;
            if (rows.length === 0) throw new NotFoundError('Cash session not found');
            authorize(rows[0].branch_id);
            if (rows[0].status !== 'closed') throw new ConflictError(`${rows[0].reference} is still open`);
            if (rows[0].review_status !== 'flagged') throw new ConflictError('Nothing to review: this session is not flagged');
            await tx.$executeRaw`UPDATE cash_sessions SET review_status = 'reviewed', reviewed_by = ${actorId}::uuid, reviewed_at = now(), review_note = ${input.note}::text WHERE id = ${input.sessionId}::uuid`;
            await writeAudit(tx, { actorId, action: 'cash_session.review', entityType: 'cash_session', entityId: input.sessionId, branchId: rows[0].branch_id, details: { note: input.note } });
            return input.sessionId;
        }, TX);
    }
}
