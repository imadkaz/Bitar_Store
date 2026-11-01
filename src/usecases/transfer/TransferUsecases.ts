import { randomUUID } from 'node:crypto';
import { AuthContext } from '../../models/AuthContext';
import { Transfer, TransferStatus, TRANSFER_STATUSES } from '../../models/Transfer.model';
import { ITransferRepository, TransferView } from '../../repositories/interfaces/ITransferRepository';
import { ITransferUnitOfWork, TransferTransaction } from '../../repositories/interfaces/ITransferUnitOfWork';
import { IStockAlertRepository } from '../../repositories/interfaces/IStockAlertRepository';
import { ConflictError } from '../../utils/exeptions/ConflictError';
import { ForbiddenError } from '../../utils/exeptions/ForbiddenError';
import { InsufficientStockError, StockShortage } from '../../utils/exeptions/InsufficientStockError';
import { NotFoundError } from '../../utils/exeptions/NotFoundError';
import { ValidationError } from '../../utils/exeptions/ValidationError';
import { isUuid } from '../../utils/uuid';
import { resolvePaging } from '../styles/paging';
import { parseOptionalUuid } from '../insight/scope';
import { parseIdempotencyKey } from '../sales/saleRequest';
import { hashOf, parseCreateTransfer, parseDispatchBody, parseReceiveBody, parseResolveBody } from './transferRequest';

export interface TransferActionResult {
    transfer: TransferView;
    replayed: boolean;     // true when this exact request had already been done: nothing new happened
}

const touches = (auth: AuthContext, t: { sourceBranchId: string; destinationBranchId: string }) => auth.canAccessBranch(t.sourceBranchId) || auth.canAccessBranch(t.destinationBranchId);

function transferId(raw: string): string {
    if (!isUuid(raw)) throw new NotFoundError('Transfer not found');
    return raw;
}

// Loads and LOCKS the transfer, and says who may act: someone who cannot see it gets "not found", someone on the wrong side gets "forbidden".
async function lockedTransferFor(tx: TransferTransaction, id: string, auth: AuthContext): Promise<Transfer> {
    const transfer = await tx.lockTransfer(id);
    if (!transfer || !touches(auth, transfer)) throw new NotFoundError('Transfer not found');
    return transfer;
}

abstract class TransferStepUsecase {
    constructor(
        protected readonly unitOfWork: ITransferUnitOfWork,
        protected readonly transfers: ITransferRepository,
    ) {}

    protected async reload(id: string, replayed: boolean): Promise<TransferActionResult> {
        return { transfer: (await this.transfers.findById(id))!, replayed };
    }
}

// ---------------------------------------------------------------------------------------------------------------
export class CreateTransferUsecase extends TransferStepUsecase {
    async execute(body: unknown, idempotencyKeyHeader: unknown, auth: AuthContext): Promise<TransferActionResult> {
        const actorId = auth.user.getId();
        if (!auth.can('transfers.dispatch')) throw new ForbiddenError('Missing permission: transfers.dispatch');
        const key = parseIdempotencyKey(idempotencyKeyHeader);
        const request = parseCreateTransfer(body);
        if (!auth.canAccessBranch(request.sourceBranchId)) throw new ForbiddenError('You can only prepare a transfer that leaves one of your places');
        const hash = hashOf('transfer.create', null, request);

        let replayed = false;
        const id = await this.unitOfWork.run(async (tx) => {
            const claim = await tx.claimIdempotencyKey(actorId, 'transfer.create', key, hash);
            if (claim.kind === 'replay') { replayed = true; return claim.resourceId; }
            if (claim.kind === 'different_request') throw new ConflictError('This Idempotency-Key was already used for a different request');
            if (claim.kind === 'in_progress') throw new ConflictError('This request is already being processed');

            const source = await tx.findPlace(request.sourceBranchId);
            const destination = await tx.findPlace(request.destinationBranchId);
            if (!source || !destination) throw new NotFoundError('Place not found');
            if (!source.isActive || !destination.isActive) throw new ConflictError('Both places must be active');
            const skuIds = request.lines.map((l) => l.skuId);
            const found = new Map((await tx.findSkus(skuIds)).map((s) => [s.skuId, s]));
            for (const skuId of skuIds) {
                const sku = found.get(skuId);
                if (!sku) throw new NotFoundError('Sku not found');
                if (!sku.skuActive || !sku.styleActive) throw new ConflictError(`Sku ${sku.skuCode} is not for sale`);
            }
            const transfer = Transfer.create({ id: randomUUID(), sourceBranchId: source.id, destinationBranchId: destination.id, note: request.note, requestedBy: actorId, lines: request.lines });
            await tx.insertTransfer(transfer, actorId);
            await tx.audit({ actorId, action: 'transfer.create', entityType: 'transfer', entityId: transfer.id, branchId: source.id, details: { to: destination.code, from: source.code, lines: request.lines.length } });
            await tx.completeIdempotencyKey(claim.keyId, 'transfer', transfer.id);
            return transfer.id;
        });
        return this.reload(id, replayed);
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The sender sends: the pieces leave its sellable stock and are "on the road" to the destination. One transaction.
export class DispatchTransferUsecase extends TransferStepUsecase {
    constructor(unitOfWork: ITransferUnitOfWork, transfers: ITransferRepository, private readonly alerts: IStockAlertRepository, private readonly now: () => Date = () => new Date()) {
        super(unitOfWork, transfers);
    }

    async execute(rawId: string, body: unknown, idempotencyKeyHeader: unknown, auth: AuthContext): Promise<TransferActionResult> {
        const actorId = auth.user.getId();
        if (!auth.can('transfers.dispatch')) throw new ForbiddenError('Missing permission: transfers.dispatch');
        const id = transferId(rawId);
        const key = parseIdempotencyKey(idempotencyKeyHeader);
        const only = parseDispatchBody(body);
        const hash = hashOf('transfer.dispatch', id, only ?? null);
        let shortages: StockShortage[] = [];
        let sourceId = '';

        let replayed = false;
        try {
            await this.unitOfWork.run(async (tx) => {
                const claim = await tx.claimIdempotencyKey(actorId, 'transfer.dispatch', key, hash);
                if (claim.kind === 'replay') { replayed = true; return; }
                if (claim.kind === 'different_request') throw new ConflictError('This Idempotency-Key was already used for a different request');
                if (claim.kind === 'in_progress') throw new ConflictError('This request is already being processed');

                const transfer = await lockedTransferFor(tx, id, auth);
                if (!auth.canAccessBranch(transfer.sourceBranchId)) throw new ForbiddenError('Only the sending place can dispatch');
                sourceId = transfer.sourceBranchId;
                const destination = await tx.findPlace(transfer.destinationBranchId);
                if (!destination?.isActive) throw new ConflictError('The destination is inactive');

                const moves = transfer.dispatch(only);

                // lock first, THEN look at the quantities, exactly like a sale
                const leaving = moves.filter((m) => m.bucket === 'sellable');
                const skuIds = leaving.map((m) => m.skuId).sort();
                const available = await tx.lockStock(transfer.sourceBranchId, skuIds, 'sellable');
                const codes = new Map((await tx.findSkus(skuIds)).map((s) => [s.skuId, s.skuCode]));
                shortages = leaving
                    .filter((m) => (available.get(m.skuId) ?? 0) < -m.delta)
                    .map((m) => ({ skuId: m.skuId, skuCode: codes.get(m.skuId) ?? m.skuId, requested: -m.delta, available: available.get(m.skuId) ?? 0 }));
                if (shortages.length > 0) throw new InsufficientStockError(shortages);

                await tx.applyMoves(id, moves, actorId, claim.keyId);
                await tx.saveTransfer(transfer, actorId, { by: actorId, at: this.now() });
                await tx.audit({ actorId, action: 'transfer.dispatch', entityType: 'transfer', entityId: id, branchId: transfer.sourceBranchId, details: { sent: transfer.getLines().reduce((s, l) => s + l.dispatchedQty, 0) } });
                await tx.completeIdempotencyKey(claim.keyId, 'transfer', id);
            });
        } catch (error) {
            // the transaction was rolled back, so the alert is written separately, afterwards
            if (error instanceof InsufficientStockError) {
                await this.alerts.recordInsufficient(shortages.map((s) => ({ operation: 'transfer.dispatch', branchId: sourceId, skuId: s.skuId, requestedQuantity: s.requested, availableQuantity: s.available, actorId, idempotencyKey: key })));
            }
            throw error;
        }
        return this.reload(id, replayed);
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The destination says what arrived: good pieces go on sale, damaged ones to hold. It can be done in several rounds.
export class ReceiveTransferUsecase extends TransferStepUsecase {
    async execute(rawId: string, body: unknown, idempotencyKeyHeader: unknown, auth: AuthContext): Promise<TransferActionResult> {
        const actorId = auth.user.getId();
        if (!auth.can('transfers.receive')) throw new ForbiddenError('Missing permission: transfers.receive');
        const id = transferId(rawId);
        const key = parseIdempotencyKey(idempotencyKeyHeader);
        const items = parseReceiveBody(body);
        const hash = hashOf('transfer.receive', id, items);

        let replayed = false;
        await this.unitOfWork.run(async (tx) => {
            const claim = await tx.claimIdempotencyKey(actorId, 'transfer.receive', key, hash);
            if (claim.kind === 'replay') { replayed = true; return; }
            if (claim.kind === 'different_request') throw new ConflictError('This Idempotency-Key was already used for a different request');
            if (claim.kind === 'in_progress') throw new ConflictError('This request is already being processed');

            const transfer = await lockedTransferFor(tx, id, auth);
            if (!auth.canAccessBranch(transfer.destinationBranchId)) throw new ForbiddenError('Only the receiving place can receive');
            const moves = transfer.receive(items);
            await tx.applyMoves(id, moves, actorId, claim.keyId);
            await tx.saveTransfer(transfer, actorId);
            const damaged = items.reduce((s, i) => s + (i.damaged ?? 0), 0);
            await tx.audit({ actorId, action: 'transfer.receive', entityType: 'transfer', entityId: id, branchId: transfer.destinationBranchId, details: { accepted: items.reduce((s, i) => s + i.accepted, 0), damaged, status: transfer.getStatus() } });
            await tx.completeIdempotencyKey(claim.keyId, 'transfer', id);
        });
        return this.reload(id, replayed);
    }
}

// ---------------------------------------------------------------------------------------------------------------
// A manager confirms that what never arrived is lost (with the reason), so the transfer can be closed.
export class ResolveTransferUsecase extends TransferStepUsecase {
    async execute(rawId: string, body: unknown, idempotencyKeyHeader: unknown, auth: AuthContext): Promise<TransferActionResult> {
        const actorId = auth.user.getId();
        if (!auth.can('transfers.dispatch')) throw new ForbiddenError('Missing permission: transfers.dispatch');
        const id = transferId(rawId);
        const key = parseIdempotencyKey(idempotencyKeyHeader);
        const { reason, lines } = parseResolveBody(body);
        const hash = hashOf('transfer.resolve', id, { reason, lines: lines ?? null });

        let replayed = false;
        await this.unitOfWork.run(async (tx) => {
            const claim = await tx.claimIdempotencyKey(actorId, 'transfer.resolve', key, hash);
            if (claim.kind === 'replay') { replayed = true; return; }
            if (claim.kind === 'different_request') throw new ConflictError('This Idempotency-Key was already used for a different request');
            if (claim.kind === 'in_progress') throw new ConflictError('This request is already being processed');

            const transfer = await lockedTransferFor(tx, id, auth);
            const moves = transfer.resolve(reason, lines);
            await tx.applyMoves(id, moves, actorId, claim.keyId);
            await tx.saveTransfer(transfer, actorId);
            await tx.audit({ actorId, action: 'transfer.resolve', entityType: 'transfer', entityId: id, branchId: transfer.destinationBranchId, details: { lost: moves.reduce((s, m) => s - m.delta, 0), reason: (reason as string).trim(), status: transfer.getStatus() } });
            await tx.completeIdempotencyKey(claim.keyId, 'transfer', id);
        });
        return this.reload(id, replayed);
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Only a draft can be cancelled. Asking again changes nothing.
export class CancelTransferUsecase extends TransferStepUsecase {
    async execute(rawId: string, auth: AuthContext): Promise<TransferView> {
        const actorId = auth.user.getId();
        if (!auth.can('transfers.dispatch')) throw new ForbiddenError('Missing permission: transfers.dispatch');
        const id = transferId(rawId);
        await this.unitOfWork.run(async (tx) => {
            const transfer = await lockedTransferFor(tx, id, auth);
            if (!auth.canAccessBranch(transfer.sourceBranchId)) throw new ForbiddenError('Only the sending place can cancel');
            if (transfer.getStatus() === 'cancelled') return;
            transfer.cancel();
            await tx.saveTransfer(transfer, actorId);
            await tx.audit({ actorId, action: 'transfer.cancel', entityType: 'transfer', entityId: id, branchId: transfer.sourceBranchId });
        });
        return (await this.transfers.findById(id))!;
    }
}

// ---------------------------------------------------------------------------------------------------------------
export class GetTransferUsecase {
    constructor(private readonly transfers: ITransferRepository) {}

    // a transfer that touches none of your places looks like a transfer that does not exist
    async execute(rawId: string, auth: AuthContext): Promise<TransferView> {
        const id = transferId(rawId);
        const view = await this.transfers.findById(id);
        if (!view || !(auth.canAccessBranch(view.source.id) || auth.canAccessBranch(view.destination.id))) throw new NotFoundError('Transfer not found');
        return view;
    }
}

export class ListTransfersUsecase {
    constructor(private readonly transfers: ITransferRepository) {}

    async execute(input: { branchId?: unknown; status?: unknown; limit?: unknown; offset?: unknown }, auth: AuthContext): Promise<{ items: TransferView[]; total: number }> {
        const branchId = parseOptionalUuid(input.branchId, 'branchId');
        if (branchId && !auth.canAccessBranch(branchId)) throw new ForbiddenError('You cannot see the transfers of this place');
        let status: TransferStatus | undefined;
        if (input.status !== undefined) {
            if (typeof input.status !== 'string' || !TRANSFER_STATUSES.includes(input.status as TransferStatus)) throw new ValidationError(`status must be one of: ${TRANSFER_STATUSES.join(', ')}`);
            status = input.status as TransferStatus;
        }
        const { limit, offset } = resolvePaging(input.limit, input.offset);
        // the admin sees every transfer; anyone else only the ones that touch their places
        const placeIds = auth.isAdmin() ? undefined : auth.getBranchIds();
        return this.transfers.list({ placeIds, branchId, status, limit, offset });
    }
}
