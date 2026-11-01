import { randomUUID } from 'node:crypto';
import { StockBucket, StockMove, Transfer, TransferStatus } from '../models/Transfer.model';
import { AuditInput } from '../repositories/audit';
import { IdempotencyClaim, SkuForSale } from '../repositories/interfaces/ISalesUnitOfWork';
import { IStockAlertRepository, StockAlertInput } from '../repositories/interfaces/IStockAlertRepository';
import { ITransferRepository, TransferListFilter, TransferView } from '../repositories/interfaces/ITransferRepository';
import { ITransferUnitOfWork, PlaceInfo, TransferTransaction } from '../repositories/interfaces/ITransferUnitOfWork';
import { ConflictError } from '../utils/exeptions/ConflictError';

// The pretend database of the transfers, in memory. A "transaction" takes a snapshot first and puts it back if anything throws,
// so tests can prove that a failed step leaves NOTHING behind (no stock change, no key, no audit event).

interface StoredTransfer {
    id: string;
    reference: string;
    sourceBranchId: string;
    destinationBranchId: string;
    status: TransferStatus;
    note: string | null;
    requestedBy: string;
    requestedAt: Date;
    dispatchedBy: string | null;
    dispatchedAt: Date | null;
    lines: { skuId: string; requestedQty: number; dispatchedQty: number; receivedQty: number; resolvedQty: number }[];
}

export interface TransferLedgerRow { skuId: string; branchId: string; bucket: StockBucket; delta: number; balanceAfter: number; type: string; transferId: string; actorId: string; reason?: string }

export class FakeTransferWorld {
    places = new Map<string, PlaceInfo & { kind: string }>();
    skus = new Map<string, SkuForSale & { size: string; color: string }>();
    stock = new Map<string, number>();               // `${branchId}|${skuId}|${bucket}`
    transfers = new Map<string, StoredTransfer>();
    keys = new Map<string, { id: string; hash: string; resourceId?: string }>();
    ledger: TransferLedgerRow[] = [];
    audits: AuditInput[] = [];
    alerts: StockAlertInput[] = [];                  // not part of the snapshot: alerts survive a rollback, like the real ones
    users = new Map<string, string>();
    private counter = 0;

    addPlace(code: string, kind = 'branch', isActive = true): PlaceInfo & { kind: string } {
        const place = { id: randomUUID(), code, name: code, isActive, kind };
        this.places.set(place.id, place);
        return place;
    }

    addSku(overrides: Partial<SkuForSale & { size: string; color: string }> = {}) {
        const sku = { skuId: randomUUID(), skuCode: `SK-${randomUUID().slice(0, 6).toUpperCase()}`, styleName: 'Summer Dress', priceCents: 4500, currency: 'USD', skuActive: true, styleActive: true, size: 'M', color: 'Black', ...overrides };
        this.skus.set(sku.skuId, sku);
        return sku;
    }

    set(branchId: string, skuId: string, bucket: StockBucket, quantity: number) { this.stock.set(`${branchId}|${skuId}|${bucket}`, quantity); }
    qty(branchId: string, skuId: string, bucket: StockBucket): number { return this.stock.get(`${branchId}|${skuId}|${bucket}`) ?? 0; }
    nextReference(): string { return `T-${String(++this.counter).padStart(8, '0')}`; }

    snapshot() {
        return {
            stock: new Map(this.stock), keys: new Map([...this.keys].map(([k, v]) => [k, { ...v }])), ledger: [...this.ledger], audits: [...this.audits],
            transfers: new Map([...this.transfers].map(([k, v]) => [k, { ...v, lines: v.lines.map((l) => ({ ...l })) }])), counter: this.counter,
        };
    }

    restore(s: ReturnType<FakeTransferWorld['snapshot']>) {
        this.stock = s.stock; this.keys = s.keys; this.ledger = s.ledger; this.audits = s.audits; this.transfers = s.transfers; this.counter = s.counter;
    }
}

class FakeTransferTransaction implements TransferTransaction {
    constructor(private readonly w: FakeTransferWorld) {}

    async claimIdempotencyKey(userId: string, operation: string, key: string, hash: string): Promise<IdempotencyClaim> {
        const id = `${userId}|${operation}|${key}`;
        const existing = this.w.keys.get(id);
        if (!existing) {
            const created = { id: randomUUID(), hash };
            this.w.keys.set(id, created);
            return { kind: 'claimed', keyId: created.id };
        }
        if (existing.hash !== hash) return { kind: 'different_request' };
        return existing.resourceId ? { kind: 'replay', resourceId: existing.resourceId } : { kind: 'in_progress' };
    }

    async findSkus(skuIds: string[]) { return skuIds.map((id) => this.w.skus.get(id)).filter((s): s is NonNullable<typeof s> => !!s); }
    async findPlace(id: string) { return this.w.places.get(id) ?? null; }

    async insertTransfer(transfer: Transfer, actorId: string) {
        this.w.transfers.set(transfer.id, {
            id: transfer.id, reference: this.w.nextReference(), sourceBranchId: transfer.sourceBranchId, destinationBranchId: transfer.destinationBranchId, status: 'draft',
            note: transfer.note, requestedBy: actorId, requestedAt: new Date(), dispatchedBy: null, dispatchedAt: null, lines: transfer.getLines().map((l) => ({ ...l })),
        });
    }

    async lockTransfer(id: string) {
        const t = this.w.transfers.get(id);
        return t ? Transfer.restore({ id: t.id, reference: t.reference, sourceBranchId: t.sourceBranchId, destinationBranchId: t.destinationBranchId, status: t.status, note: t.note, requestedBy: t.requestedBy, lines: t.lines }) : null;
    }

    async lockStock(branchId: string, skuIds: string[], bucket: StockBucket) { return new Map(skuIds.map((id) => [id, this.w.qty(branchId, id, bucket)])); }

    async applyMoves(transferId: string, moves: StockMove[], actorId: string) {
        for (const move of moves) {
            const after = this.w.qty(move.branchId, move.skuId, move.bucket) + move.delta;
            if (after < 0) throw new ConflictError('the database CHECK (quantity >= 0) would refuse this');
            this.w.set(move.branchId, move.skuId, move.bucket, after);
            this.w.ledger.push({ skuId: move.skuId, branchId: move.branchId, bucket: move.bucket, delta: move.delta, balanceAfter: after, type: move.type, transferId, actorId, reason: move.reason });
        }
    }

    async saveTransfer(transfer: Transfer, actorId: string, dispatched?: { by: string; at: Date }) {
        const stored = this.w.transfers.get(transfer.id)!;
        stored.status = transfer.getStatus();
        stored.lines = transfer.getLines().map((l) => ({ ...l }));
        if (dispatched) { stored.dispatchedBy = dispatched.by; stored.dispatchedAt = dispatched.at; }
        void actorId;
    }

    async audit(event: AuditInput) { this.w.audits.push(event); }
    async completeIdempotencyKey(keyId: string, _type: string, resourceId: string) { for (const k of this.w.keys.values()) if (k.id === keyId) k.resourceId = resourceId; }
}

export class FakeTransferUnitOfWork implements ITransferUnitOfWork {
    constructor(private readonly world: FakeTransferWorld) {}

    async run<T>(work: (tx: TransferTransaction) => Promise<T>): Promise<T> {
        const snapshot = this.world.snapshot();
        try {
            return await work(new FakeTransferTransaction(this.world));
        } catch (error) {
            this.world.restore(snapshot);
            throw error;
        }
    }
}

export class FakeTransferRepository implements ITransferRepository {
    constructor(private readonly w: FakeTransferWorld) {}

    private view(t: StoredTransfer): TransferView {
        const place = (id: string) => { const p = this.w.places.get(id)!; return { id: p.id, code: p.code, name: p.name, kind: p.kind }; };
        const who = (id: string) => ({ id, name: this.w.users.get(id) ?? null });
        return {
            id: t.id, reference: t.reference, status: t.status, source: place(t.sourceBranchId), destination: place(t.destinationBranchId), note: t.note,
            requestedBy: who(t.requestedBy), requestedAt: t.requestedAt, dispatchedBy: t.dispatchedBy ? who(t.dispatchedBy) : null, dispatchedAt: t.dispatchedAt,
            lines: t.lines.map((l) => {
                const sku = this.w.skus.get(l.skuId)!;
                return { skuId: l.skuId, skuCode: sku.skuCode, styleName: sku.styleName, size: sku.size, color: sku.color, requestedQty: l.requestedQty, dispatchedQty: l.dispatchedQty, receivedQty: l.receivedQty, resolvedQty: l.resolvedQty, outstandingQty: l.dispatchedQty - l.receivedQty - l.resolvedQty };
            }),
        };
    }

    async findById(id: string) { const t = this.w.transfers.get(id); return t ? this.view(t) : null; }

    async list(filter: TransferListFilter) {
        const touches = (t: StoredTransfer, ids: string[]) => ids.includes(t.sourceBranchId) || ids.includes(t.destinationBranchId);
        const all = [...this.w.transfers.values()]
            .filter((t) => (!filter.placeIds || touches(t, filter.placeIds)) && (!filter.branchId || touches(t, [filter.branchId])) && (!filter.status || t.status === filter.status))
            .sort((a, b) => b.reference.localeCompare(a.reference));
        return { items: all.slice(filter.offset, filter.offset + filter.limit).map((t) => this.view(t)), total: all.length };
    }
}

export class FakeTransferAlertRepository implements IStockAlertRepository {
    constructor(private readonly world: FakeTransferWorld) {}

    async recordInsufficient(alerts: StockAlertInput[]) {
        for (const a of alerts) {
            if (!this.world.alerts.some((x) => x.actorId === a.actorId && x.operation === a.operation && x.idempotencyKey === a.idempotencyKey && x.skuId === a.skuId)) this.world.alerts.push(a);
        }
    }
}
