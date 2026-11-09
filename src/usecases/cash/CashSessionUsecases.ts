import { createHash } from 'node:crypto';
import { AuthContext } from '../../models/AuthContext';
import { parseCashMovement, parseCloseSession, parseCorrection, parseHandover, parseOpenSession, parseReview } from '../../models/CashSession.model';
import { Permission } from '../../models/Permission';
import { UserRole } from '../../models/User.model';
import { CashSessionListFilter, CashSessionSummary, CashSessionView, ICashSessionRepository } from '../../repositories/interfaces/ICashSessionRepository';
import { IBranchRepository } from '../../repositories/interfaces/IBranchRepository';
import { ConflictError } from '../../utils/exeptions/ConflictError';
import { ForbiddenError } from '../../utils/exeptions/ForbiddenError';
import { NotFoundError } from '../../utils/exeptions/NotFoundError';
import { ValidationError } from '../../utils/exeptions/ValidationError';
import { isUuid } from '../../utils/uuid';
import { resolvePaging } from '../styles/paging';
import { parseOptionalUuid, parseShopDay } from '../insight/scope';
import { parseIdempotencyKey } from '../sales/saleRequest';

// Who may do what (approved "Cash Sessions and Payments"):
//   open, take over (handover), close, cash in or out: a manager, or an employee who was GRANTED that permission, at a branch they reach.
//   correct a closed session and review a difference: a manager only. A grant to an employee never reaches these two.
// The session belongs to the BRANCH: switching the signed-in account does not close it; each action records the user.
const isManager = (auth: AuthContext) => auth.user.getRole() === UserRole.ADMIN || auth.user.getRole() === UserRole.MANAGER;
const need = (auth: AuthContext, permission: Permission) => { if (!auth.can(permission)) throw new ForbiddenError(`Missing permission: ${permission}`); };
const needManager = (auth: AuthContext) => { if (!isManager(auth)) throw new ForbiddenError('Only a manager can do this'); };
const hasAnyCashRight = (auth: AuthContext) => isManager(auth) || (['cash.open', 'cash.accept', 'cash.close', 'cash.move'] as Permission[]).some((p) => auth.can(p));
const idOf = (raw: string) => { if (!isUuid(raw)) throw new NotFoundError('Cash session not found'); return raw; };
// a place the person does not reach does not exist for them
const reachOrNotFound = (auth: AuthContext) => (branchId: string): void => { if (!auth.canAccessBranch(branchId)) throw new NotFoundError('Cash session not found'); };
const hash = (operation: string, ...parts: unknown[]) => createHash('sha256').update(JSON.stringify([operation, ...parts])).digest('hex');

export class OpenCashSessionUsecase {
    constructor(private readonly sessions: ICashSessionRepository, private readonly branches: IBranchRepository) {}
    async execute(body: unknown, auth: AuthContext): Promise<CashSessionView> {
        need(auth, 'cash.open');
        const request = parseOpenSession(body);
        const branch = await this.branches.findById(request.branchId);
        if (!branch || !auth.canAccessBranch(request.branchId)) throw new NotFoundError('Branch not found');
        if (branch.isWarehouse()) throw new ConflictError('The warehouse has no cash drawer');
        if (!branch.isActive()) throw new ConflictError('This branch is inactive');
        const id = await this.sessions.open({ branchId: request.branchId, openingCents: request.openingCents, note: request.note }, auth.user.getId());
        return (await this.sessions.findById(id))!;
    }
}

export class AddCashMovementUsecase {
    constructor(private readonly sessions: ICashSessionRepository) {}
    async execute(rawId: string, body: unknown, keyHeader: unknown, auth: AuthContext): Promise<{ session: CashSessionView; replayed: boolean }> {
        need(auth, 'cash.move');
        const id = idOf(rawId);
        const key = parseIdempotencyKey(keyHeader);
        const request = parseCashMovement(body);
        const done = await this.sessions.addMovement({ sessionId: id, ...request, key, requestHash: hash('cash_movement.create', id, request) }, auth.user.getId(), reachOrNotFound(auth));
        return { session: (await this.sessions.findById(id))!, replayed: done.replayed };
    }
}

export class HandoverCashSessionUsecase {
    constructor(private readonly sessions: ICashSessionRepository) {}
    // the person TAKING the drawer calls this: they count it and accept responsibility for what they counted
    async execute(rawId: string, body: unknown, keyHeader: unknown, auth: AuthContext): Promise<{ session: CashSessionView; replayed: boolean }> {
        need(auth, 'cash.accept');
        const id = idOf(rawId);
        const key = parseIdempotencyKey(keyHeader);
        const request = parseHandover(body);
        const done = await this.sessions.handover({ sessionId: id, ...request, key, requestHash: hash('cash_handover.create', id, request) }, auth.user.getId(), reachOrNotFound(auth));
        return { session: (await this.sessions.findById(id))!, replayed: done.replayed };
    }
}

export class CloseCashSessionUsecase {
    constructor(private readonly sessions: ICashSessionRepository) {}
    async execute(rawId: string, body: unknown, auth: AuthContext): Promise<CashSessionView> {
        need(auth, 'cash.close');
        const id = idOf(rawId);
        await this.sessions.close({ sessionId: id, ...parseCloseSession(body) }, auth.user.getId(), reachOrNotFound(auth));
        return (await this.sessions.findById(id))!;
    }
}

export class CorrectCashSessionUsecase {
    constructor(private readonly sessions: ICashSessionRepository) {}
    async execute(rawId: string, body: unknown, auth: AuthContext): Promise<CashSessionView> {
        needManager(auth);
        const id = idOf(rawId);
        await this.sessions.correct({ sessionId: id, ...parseCorrection(body) }, auth.user.getId(), reachOrNotFound(auth));
        return (await this.sessions.findById(id))!;
    }
}

export class ReviewCashSessionUsecase {
    constructor(private readonly sessions: ICashSessionRepository) {}
    async execute(rawId: string, body: unknown, auth: AuthContext): Promise<CashSessionView> {
        needManager(auth);
        const id = idOf(rawId);
        await this.sessions.review({ sessionId: id, ...parseReview(body) }, auth.user.getId(), reachOrNotFound(auth));
        return (await this.sessions.findById(id))!;
    }
}

export class GetCashSessionUsecase {
    constructor(private readonly sessions: ICashSessionRepository) {}
    async execute(rawId: string, auth: AuthContext): Promise<CashSessionView> {
        if (!hasAnyCashRight(auth)) throw new ForbiddenError('You have no cash permission');
        const session = await this.sessions.findById(idOf(rawId));
        if (!session || !auth.canAccessBranch(session.branch.id)) throw new NotFoundError('Cash session not found');
        return session;
    }
}

// the open session of a branch: null when there is none (the till shows "open the drawer")
export class GetOpenCashSessionUsecase {
    constructor(private readonly sessions: ICashSessionRepository) {}
    async execute(rawBranchId: unknown, auth: AuthContext): Promise<CashSessionView | null> {
        if (!hasAnyCashRight(auth) && !auth.can('sales.create')) throw new ForbiddenError('You have no cash permission');
        const branchId = parseOptionalUuid(rawBranchId, 'branchId');
        if (!branchId) throw new ValidationError('branchId is required');
        if (!auth.canAccessBranch(branchId)) throw new NotFoundError('Branch not found');
        return this.sessions.findOpen(branchId);
    }
}

export class ListCashSessionsUsecase {
    constructor(private readonly sessions: ICashSessionRepository) {}
    async execute(input: { branchId?: unknown; status?: unknown; review?: unknown; from?: unknown; to?: unknown; limit?: unknown; offset?: unknown }, auth: AuthContext): Promise<{ items: CashSessionSummary[]; total: number }> {
        if (!hasAnyCashRight(auth)) throw new ForbiddenError('You have no cash permission');
        const branchId = parseOptionalUuid(input.branchId, 'branchId');
        if (branchId && !auth.canAccessBranch(branchId)) throw new ForbiddenError('You cannot see the cash sessions of this place');
        if (input.status !== undefined && input.status !== 'open' && input.status !== 'closed') throw new ValidationError('status must be open or closed');
        if (input.review !== undefined && !['none', 'flagged', 'reviewed'].includes(input.review as string)) throw new ValidationError('review must be none, flagged or reviewed');
        const from = parseShopDay(input.from, 'from');
        const to = parseShopDay(input.to, 'to');
        if (from && to && from > to) throw new ValidationError('from must not be after to');
        const { limit, offset } = resolvePaging(input.limit, input.offset);
        const filter: CashSessionListFilter = { branchIds: auth.user.getRole() === UserRole.ADMIN ? null : auth.getBranchIds(), branchId, status: input.status as 'open' | 'closed' | undefined, review: input.review as 'none' | 'flagged' | 'reviewed' | undefined, from, to, limit, offset };
        return this.sessions.list(filter);
    }
}
