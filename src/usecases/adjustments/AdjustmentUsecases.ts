import { AuthContext } from '../../models/AuthContext';
import { ADJUSTMENT_REASONS, parseAdjustment, planAdjustment } from '../../models/Adjustment.model';
import { AdjustmentView, IAdjustmentRepository } from '../../repositories/interfaces/IAdjustmentRepository';
import { IAdjustmentUnitOfWork } from '../../repositories/interfaces/IAdjustmentUnitOfWork';
import { IBranchRepository } from '../../repositories/interfaces/IBranchRepository';
import { ConflictError } from '../../utils/exeptions/ConflictError';
import { ForbiddenError } from '../../utils/exeptions/ForbiddenError';
import { InsufficientStockError } from '../../utils/exeptions/InsufficientStockError';
import { NotFoundError } from '../../utils/exeptions/NotFoundError';
import { ValidationError } from '../../utils/exeptions/ValidationError';
import { createHash } from 'node:crypto';
import { resolvePaging } from '../styles/paging';
import { parseDateRange, parseOptionalUuid, parseSlug, resolveBranchScope } from '../insight/scope';
import { parseIdempotencyKey } from '../sales/saleRequest';

export interface AdjustmentResult {
    adjustment: AdjustmentView;
    replayed: boolean;     // true when this exact request had already been done: nothing new happened
}

// Correct the stock of one sku at one place: a count that does not match, a damaged piece, a lost one, one that was found.
// It needs a reason and a note, it can never be edited, and it is written to the ledger and the audit log with who did it.
export class CreateAdjustmentUsecase {
    constructor(private readonly unitOfWork: IAdjustmentUnitOfWork, private readonly adjustments: IAdjustmentRepository) {}

    async execute(body: unknown, idempotencyKeyHeader: unknown, auth: AuthContext): Promise<AdjustmentResult> {
        const actorId = auth.user.getId();
        if (!auth.can('adjustments.create')) throw new ForbiddenError('Missing permission: adjustments.create');
        const key = parseIdempotencyKey(idempotencyKeyHeader);
        const request = parseAdjustment(body);
        if (!auth.canAccessBranch(request.branchId)) throw new ForbiddenError('You cannot adjust the stock of this place');
        const moves = planAdjustment(request);
        const hash = createHash('sha256').update(JSON.stringify(['adjustment.create', request])).digest('hex');

        let replayed = false;
        const id = await this.unitOfWork.run(async (tx) => {
            const claim = await tx.claimIdempotencyKey(actorId, 'adjustment.create', key, hash);
            if (claim.kind === 'replay') { replayed = true; return claim.resourceId; }
            if (claim.kind === 'different_request') throw new ConflictError('This Idempotency-Key was already used for a different request');
            if (claim.kind === 'in_progress') throw new ConflictError('This request is already being processed');

            const place = await tx.placeExists(request.branchId);
            if (!place) throw new NotFoundError('Place not found');
            const sku = (await tx.findSkus([request.skuId]))[0];
            if (!sku) throw new NotFoundError('Sku not found');       // an archived sku can still be corrected

            // lock first, THEN look at the quantities, like a sale
            const locked = await tx.lockBalances(request.branchId, request.skuId, [...new Set(moves.map((m) => m.bucket))]);
            const short = moves.filter((m) => m.delta < 0 && (locked.get(m.bucket) ?? 0) < -m.delta);
            if (short.length > 0) {
                throw new InsufficientStockError(short.map((m) => ({ skuId: sku.skuId, skuCode: sku.skuCode, requested: -m.delta, available: locked.get(m.bucket) ?? 0 })));
            }

            const created = await tx.insertAdjustment(request, actorId, claim.keyId);
            await tx.applyMoves(created.id, request, moves, actorId, claim.keyId);
            await tx.audit({
                actorId, action: 'stock.adjust', entityType: 'adjustment', entityId: created.id, branchId: request.branchId,
                details: { sku: sku.skuCode, bucket: request.bucket, delta: request.quantityDelta, reason: request.reason, reference: created.reference },
            });
            await tx.completeIdempotencyKey(claim.keyId, 'adjustment', created.id);
            return created.id;
        });
        return { adjustment: (await this.adjustments.findById(id))!, replayed };
    }
}

// The history of the corrections, any period, for the places you reach.
export class ListAdjustmentsUsecase {
    constructor(private readonly branches: IBranchRepository, private readonly adjustments: IAdjustmentRepository, private readonly now: () => Date = () => new Date()) {}

    async execute(input: { branchId?: unknown; skuId?: unknown; reason?: unknown; from?: unknown; to?: unknown; limit?: unknown; offset?: unknown }, auth: AuthContext): Promise<{ items: AdjustmentView[]; total: number }> {
        if (!auth.can('adjustments.create')) throw new ForbiddenError('Missing permission: adjustments.create');
        const reason = parseSlug(input.reason, 'reason');
        if (reason !== undefined && !(ADJUSTMENT_REASONS as readonly string[]).includes(reason)) throw new ValidationError(`reason must be one of: ${ADJUSTMENT_REASONS.join(', ')}`);
        const skuId = parseOptionalUuid(input.skuId, 'skuId');
        // no dates = every period (a list of corrections is short); with dates the range is checked
        const dated = input.from !== undefined || input.to !== undefined;
        const range = dated ? parseDateRange(input.from, input.to, this.now()) : undefined;
        const { limit, offset } = resolvePaging(input.limit, input.offset);
        const scope = await resolveBranchScope(auth, input.branchId, this.branches, { onlyBranches: false });
        return this.adjustments.list({ branchIds: scope.map((b) => b.getId()), skuId, reason, from: range?.from, to: range?.to, limit, offset });
    }
}
