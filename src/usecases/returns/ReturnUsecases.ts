import { createHash } from 'node:crypto';
import { AuthContext } from '../../models/AuthContext';
import { parseApproval, parseCreateReturn, parseHandback, parseRefundPayment, parseRejection, parseRelease } from '../../models/Return.model';
import { Permission } from '../../models/Permission';
import { UserRole } from '../../models/User.model';
import { IReturnRepository, ReturnableSale, ReturnListFilter, ReturnSummary, ReturnView } from '../../repositories/interfaces/IReturnRepository';
import { ForbiddenError } from '../../utils/exeptions/ForbiddenError';
import { NotFoundError } from '../../utils/exeptions/NotFoundError';
import { ValidationError } from '../../utils/exeptions/ValidationError';
import { isUuid } from '../../utils/uuid';
import { resolvePaging } from '../styles/paging';
import { parseOptionalUuid, parseShopDay } from '../insight/scope';
import { parseIdempotencyKey } from '../sales/saleRequest';

// Who may do what (approved BL-04):
//   receive the goods into custody, take them from a customer who kept them, hand a rejected return back: returns.create, at the branch that takes them
//   approve or reject, release the goods to sale: a manager only (a grant to an employee never reaches these)
//   pay a refund: returns.refund (a manager has it), at the receiving branch
// Receiving, approving, releasing and paying are DISTINCT events: none of them silently triggers another.
const isManager = (auth: AuthContext) => auth.user.getRole() === UserRole.ADMIN || auth.user.getRole() === UserRole.MANAGER;
const need = (auth: AuthContext, permission: Permission) => { if (!auth.can(permission)) throw new ForbiddenError(`Missing permission: ${permission}`); };
const needManager = (auth: AuthContext) => { if (!isManager(auth)) throw new ForbiddenError('Only a manager can decide a return or release its goods'); };
const canSee = (auth: AuthContext) => isManager(auth) || auth.can('returns.create') || auth.can('returns.refund');
const idOf = (raw: string) => { if (!isUuid(raw)) throw new NotFoundError('Return not found'); return raw; };
const atMyBranch = (auth: AuthContext) => (branchId: string): void => { if (!auth.canAccessBranch(branchId)) throw new NotFoundError('Return not found'); };
const hash = (operation: string, ...parts: unknown[]) => createHash('sha256').update(JSON.stringify([operation, ...parts])).digest('hex');
type Result = { view: ReturnView; replayed: boolean };

export class FindReturnableSaleUsecase {
    constructor(private readonly returns: IReturnRepository) {}
    // a customer may return at ANY branch: the sale is found by its id or its number, wherever it was made
    async execute(saleKey: unknown, auth: AuthContext): Promise<ReturnableSale> {
        need(auth, 'returns.create');
        if (typeof saleKey !== 'string' || saleKey.trim().length < 3 || saleKey.trim().length > 50) throw new ValidationError('sale must be the id or the number of the sale, like S-00000012');
        const found = await this.returns.returnable(saleKey.trim(), isManager(auth), auth.getBranchIds());
        if (!found) throw new NotFoundError('Sale not found');
        return found;
    }
}

export class ReceiveReturnUsecase {
    constructor(private readonly returns: IReturnRepository) {}
    async execute(body: unknown, keyHeader: unknown, auth: AuthContext): Promise<Result> {
        need(auth, 'returns.create');
        const key = parseIdempotencyKey(keyHeader);
        const request = parseCreateReturn(body);
        const done = await this.returns.create(request, auth.user.getId(), key, hash('return.create', request), isManager(auth), (branchId) => { if (!auth.canAccessBranch(branchId)) throw new NotFoundError('Branch not found'); });
        return { view: (await this.returns.findById(done.id))!, replayed: done.replayed };
    }
}

export class TakeCustodyUsecase {
    constructor(private readonly returns: IReturnRepository) {}
    async execute(rawId: string, auth: AuthContext): Promise<ReturnView> {
        need(auth, 'returns.create');
        const id = idOf(rawId);
        await this.returns.takeCustody(id, auth.user.getId(), atMyBranch(auth));
        return (await this.returns.findById(id))!;
    }
}

export class ApproveReturnUsecase {
    constructor(private readonly returns: IReturnRepository) {}
    async execute(rawId: string, body: unknown, keyHeader: unknown, auth: AuthContext): Promise<Result> {
        needManager(auth);
        const id = idOf(rawId);
        const key = parseIdempotencyKey(keyHeader);
        const { reason } = parseApproval(body);
        const done = await this.returns.approve(id, reason, auth.user.getId(), key, hash('return.approve', id, reason), atMyBranch(auth));
        return { view: (await this.returns.findById(id))!, replayed: done.replayed };
    }
}

export class RejectReturnUsecase {
    constructor(private readonly returns: IReturnRepository) {}
    async execute(rawId: string, body: unknown, auth: AuthContext): Promise<ReturnView> {
        needManager(auth);
        const id = idOf(rawId);
        await this.returns.reject(id, parseRejection(body).reason, auth.user.getId(), atMyBranch(auth));
        return (await this.returns.findById(id))!;
    }
}

export class HandbackReturnUsecase {
    constructor(private readonly returns: IReturnRepository) {}
    async execute(rawId: string, body: unknown, auth: AuthContext): Promise<ReturnView> {
        need(auth, 'returns.create');
        const id = idOf(rawId);
        await this.returns.handback(id, parseHandback(body).recipient, auth.user.getId(), atMyBranch(auth));
        return (await this.returns.findById(id))!;
    }
}

export class ReleaseReturnUsecase {
    constructor(private readonly returns: IReturnRepository) {}
    async execute(rawId: string, body: unknown, keyHeader: unknown, auth: AuthContext): Promise<Result> {
        needManager(auth);
        const id = idOf(rawId);
        const key = parseIdempotencyKey(keyHeader);
        const { lines } = parseRelease(body);
        const done = await this.returns.release(id, lines, auth.user.getId(), key, hash('return.release', id, lines), atMyBranch(auth));
        return { view: (await this.returns.findById(id))!, replayed: done.replayed };
    }
}

export class PayRefundUsecase {
    constructor(private readonly returns: IReturnRepository) {}
    async execute(rawId: string, body: unknown, keyHeader: unknown, auth: AuthContext): Promise<Result> {
        need(auth, 'returns.refund');
        const id = idOf(rawId);
        const key = parseIdempotencyKey(keyHeader);
        const payment = parseRefundPayment(body);
        const done = await this.returns.payRefund(id, payment, auth.user.getId(), key, hash('return.refund', id, payment), atMyBranch(auth));
        return { view: (await this.returns.findById(id))!, replayed: done.replayed };
    }
}

export class GetReturnUsecase {
    constructor(private readonly returns: IReturnRepository) {}
    async execute(rawId: string, auth: AuthContext): Promise<ReturnView> {
        if (!canSee(auth)) throw new ForbiddenError('You have no returns permission');
        const found = await this.returns.findById(idOf(rawId));
        // visible to the branch that took the goods and to the branch that sold them; for anyone else it does not exist
        if (!found || !(auth.canAccessBranch(found.receivingBranch.id) || auth.canAccessBranch(found.sale.branch.id))) throw new NotFoundError('Return not found');
        return found;
    }
}

export class ListReturnsUsecase {
    constructor(private readonly returns: IReturnRepository) {}
    async execute(input: { branchId?: unknown; saleId?: unknown; status?: unknown; from?: unknown; to?: unknown; limit?: unknown; offset?: unknown }, auth: AuthContext): Promise<{ items: ReturnSummary[]; total: number }> {
        if (!canSee(auth)) throw new ForbiddenError('You have no returns permission');
        const branchId = parseOptionalUuid(input.branchId, 'branchId');
        const saleId = parseOptionalUuid(input.saleId, 'saleId');
        if (branchId && !auth.canAccessBranch(branchId)) throw new ForbiddenError('You cannot see the returns of this place');
        if (input.status !== undefined && !['in_custody', 'approved', 'rejected', 'handed_back'].includes(input.status as string)) throw new ValidationError('status must be in_custody, approved, rejected or handed_back');
        const from = parseShopDay(input.from, 'from');
        const to = parseShopDay(input.to, 'to');
        if (from && to && from > to) throw new ValidationError('from must not be after to');
        const { limit, offset } = resolvePaging(input.limit, input.offset);
        const filter: ReturnListFilter = { branchIds: auth.user.getRole() === UserRole.ADMIN ? null : auth.getBranchIds(), branchId, saleId, status: input.status as ReturnView['status'] | undefined, from, to, limit, offset };
        return this.returns.list(filter);
    }
}

export class LinkExchangeUsecase {
    constructor(private readonly returns: IReturnRepository) {}
    // body: { saleId }: the replacement sale. The net amount (the new total minus the refund) is recorded.
    async execute(rawId: string, body: unknown, auth: AuthContext): Promise<ReturnView> {
        need(auth, 'returns.create');
        const id = idOf(rawId);
        if (typeof body !== 'object' || body === null || typeof (body as { saleId?: unknown }).saleId !== 'string' || !isUuid((body as { saleId: string }).saleId)) throw new ValidationError('saleId must be the id of the replacement sale');
        await this.returns.linkExchange(id, (body as { saleId: string }).saleId, auth.user.getId(), atMyBranch(auth));
        return (await this.returns.findById(id))!;
    }
}
