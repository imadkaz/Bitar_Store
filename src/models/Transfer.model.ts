import { ConflictError } from '../utils/exeptions/ConflictError';
import { ValidationError } from '../utils/exeptions/ValidationError';

export const TRANSFER_STATUSES = ['draft', 'dispatched', 'partially_received', 'received', 'closed', 'cancelled'] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];
export const MAX_TRANSFER_LINES = 50;
export const MAX_TRANSFER_QUANTITY = 10_000;

export type StockBucket = 'sellable' | 'in_transit' | 'non_sellable';

// One change of one stock number at one place. The ledger gets a row for each.
export interface StockMove {
    skuId: string;
    branchId: string;
    bucket: StockBucket;
    delta: number;
    type: 'transfer_dispatch' | 'transfer_receipt' | 'transfer_resolution';
    reason?: string;
}

export interface TransferLineState {
    skuId: string;
    requestedQty: number;
    dispatchedQty: number;
    receivedQty: number;      // arrived at the destination, good or damaged
    resolvedQty: number;      // confirmed lost
}

export interface TransferProps {
    id: string;
    reference?: string | null;
    sourceBranchId: string;
    destinationBranchId: string;
    status?: TransferStatus;
    note?: string | null;
    requestedBy: string;
    lines: { skuId: string; quantity: number }[];
}

function whole(value: unknown, min: number, max: number, label: string): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
        throw new ValidationError(`${label} must be a whole number from ${min} to ${max}`);
    }
    return value;
}

// The life of a transfer (the flow of the foundation schema; reserving stock at approval is a later step):
//
//   draft --dispatch--> dispatched --receive--> partially_received --receive--> received
//     |                      |                        |                           (everything arrived)
//     |                      +--resolve (lost)--------+--> closed   (the rest was confirmed lost)
//     +--cancel--> cancelled
//
// Units on the road are counted at the DESTINATION, in its in_transit bucket: they are "on their way to this place".
export class Transfer {
    private constructor(
        readonly id: string,
        readonly reference: string | null,
        readonly sourceBranchId: string,
        readonly destinationBranchId: string,
        private status: TransferStatus,
        readonly note: string | null,
        readonly requestedBy: string,
        private readonly lines: TransferLineState[],
    ) {}

    static create(props: TransferProps): Transfer {
        if (props.sourceBranchId === props.destinationBranchId) throw new ValidationError('A transfer needs two different places');
        if (props.lines.length < 1) throw new ValidationError('A transfer needs at least one line');
        if (props.lines.length > MAX_TRANSFER_LINES) throw new ValidationError(`A transfer can have at most ${MAX_TRANSFER_LINES} lines`);
        if (new Set(props.lines.map((l) => l.skuId)).size !== props.lines.length) throw new ValidationError('Each sku can appear only once: raise its quantity instead');
        let note: string | null = null;
        if (props.note !== undefined && props.note !== null) {
            if (typeof props.note !== 'string') throw new ValidationError('Note must be text');
            note = props.note.trim() === '' ? null : props.note.trim();
            if (note !== null && note.length > 500) throw new ValidationError('Note must be at most 500 characters');
        }
        const lines = props.lines.map((l) => ({ skuId: l.skuId, requestedQty: whole(l.quantity, 1, MAX_TRANSFER_QUANTITY, 'Quantity'), dispatchedQty: 0, receivedQty: 0, resolvedQty: 0 }));

        return new Transfer(
            props.id, 
            props.reference ?? null, 
            props.sourceBranchId, 
            props.destinationBranchId, 
            'draft', 
            note, 
            props.requestedBy, 
            lines
        );
    }

    // from the database: no validation, it was validated when it was written
    static restore(props: Omit<TransferProps, 'lines' | 'status'> & { status: TransferStatus; lines: TransferLineState[] }): Transfer {
        return new Transfer(props.id, props.reference ?? null, props.sourceBranchId, props.destinationBranchId, props.status, props.note ?? null, props.requestedBy, props.lines.map((l) => ({ ...l })));
    }

    getStatus(): TransferStatus { return this.status; }
    getLines(): readonly TransferLineState[] { return this.lines; }
    outstanding(line: TransferLineState): number { return line.dispatchedQty - line.receivedQty - line.resolvedQty; }
    totalOutstanding(): number { return this.lines.reduce((sum, l) => sum + this.outstanding(l), 0); }

    private lineOf(skuId: string): TransferLineState {
        const line = this.lines.find((l) => l.skuId === skuId);
        if (!line) throw new ValidationError('This sku is not in the transfer');
        return line;
    }

    private static uniqueSkus(items: { skuId: string }[]) {
        if (new Set(items.map((i) => i.skuId)).size !== items.length) throw new ValidationError('Each sku can appear only once');
    }

    // Nothing was received or lost yet and units are still on the road: dispatched. Something arrived, something is still out: partially received.
    // Nothing is outstanding: received (all arrived) or closed (some were confirmed lost).
    private recomputeStatus(): void {
        if (this.totalOutstanding() > 0) {
            this.status = this.lines.some((l) => l.receivedQty > 0 || l.resolvedQty > 0) ? 'partially_received' : 'dispatched';
        } else {
            this.status = this.lines.some((l) => l.resolvedQty > 0) ? 'closed' : 'received';
        }
    }

    // Sends what was asked, or less per line (the warehouse may not have it all). Nothing is sent twice: only a draft is dispatched.
    dispatch(only?: { skuId: string; quantity: number }[]): StockMove[] {
        if (this.status !== 'draft') throw new ConflictError('Only a draft can be dispatched');
        if (only) Transfer.uniqueSkus(only);
        const wanted = new Map<string, number>();
        for (const line of this.lines) wanted.set(line.skuId, line.requestedQty);
        for (const item of only ?? []) {
            const line = this.lineOf(item.skuId);
            wanted.set(item.skuId, whole(item.quantity, 0, line.requestedQty, 'Quantity to send'));
        }
        if ([...wanted.values()].every((q) => q === 0)) throw new ValidationError('Nothing to send');

        const moves: StockMove[] = [];
        for (const line of this.lines) {
            const quantity = wanted.get(line.skuId)!;
            line.dispatchedQty = quantity;
            if (quantity === 0) continue;
            moves.push({ skuId: line.skuId, branchId: this.sourceBranchId, bucket: 'sellable', delta: -quantity, type: 'transfer_dispatch' });
            moves.push({ skuId: line.skuId, branchId: this.destinationBranchId, bucket: 'in_transit', delta: quantity, type: 'transfer_dispatch' });
        }
        this.status = 'dispatched';
        this.recomputeStatus();
        this.status = 'dispatched';          // right after sending, everything is still on the road
        return moves;
    }

    // The destination says what arrived: good pieces go on sale, damaged ones to hold. It can be done in several rounds.
    receive(items: { skuId: string; accepted: number; damaged?: number }[]): StockMove[] {
        if (this.status !== 'dispatched' && this.status !== 'partially_received') throw new ConflictError('Only a transfer on the road can be received');
        if (items.length < 1) throw new ValidationError('Say what arrived');
        Transfer.uniqueSkus(items);
        const moves: StockMove[] = [];
        for (const item of items) {
            const line = this.lineOf(item.skuId);
            const accepted = whole(item.accepted, 0, MAX_TRANSFER_QUANTITY, 'Accepted quantity');
            const damaged = whole(item.damaged ?? 0, 0, MAX_TRANSFER_QUANTITY, 'Damaged quantity');
            const arrived = accepted + damaged;
            if (arrived < 1) throw new ValidationError('Each line must say how many arrived (accepted or damaged)');
            if (arrived > this.outstanding(line)) throw new ConflictError(`Only ${this.outstanding(line)} are still on the way for this sku`);
            line.receivedQty += arrived;
            moves.push({ skuId: line.skuId, branchId: this.destinationBranchId, bucket: 'in_transit', delta: -arrived, type: 'transfer_receipt' });
            if (accepted > 0) moves.push({ skuId: line.skuId, branchId: this.destinationBranchId, bucket: 'sellable', delta: accepted, type: 'transfer_receipt' });
            if (damaged > 0) moves.push({ skuId: line.skuId, branchId: this.destinationBranchId, bucket: 'non_sellable', delta: damaged, type: 'transfer_receipt', reason: 'damaged on arrival' });
        }
        this.recomputeStatus();
        return moves;
    }

    // A manager confirms that what never arrived is lost. Without a reason it is refused.
    resolve(reason: unknown, only?: { skuId: string; quantity: number }[]): StockMove[] {
        if (this.status !== 'dispatched' && this.status !== 'partially_received') throw new ConflictError('Only a transfer with units still on the road can be resolved');
        if (typeof reason !== 'string' || reason.trim().length < 3 || reason.trim().length > 200) throw new ValidationError('A reason of 3 to 200 characters is required');
        const why = reason.trim();
        if (only) Transfer.uniqueSkus(only);
        const items = only ?? this.lines.filter((l) => this.outstanding(l) > 0).map((l) => ({ skuId: l.skuId, quantity: this.outstanding(l) }));
        if (items.length === 0) throw new ValidationError('Nothing is outstanding');
        const moves: StockMove[] = [];
        for (const item of items) {
            const line = this.lineOf(item.skuId);
            const quantity = whole(item.quantity, 1, MAX_TRANSFER_QUANTITY, 'Quantity');
            if (quantity > this.outstanding(line)) throw new ConflictError(`Only ${this.outstanding(line)} are still on the way for this sku`);
            line.resolvedQty += quantity;
            moves.push({ skuId: line.skuId, branchId: this.destinationBranchId, bucket: 'in_transit', delta: -quantity, type: 'transfer_resolution', reason: why });
        }
        this.recomputeStatus();
        return moves;
    }

    cancel(): void {
        if (this.status !== 'draft') throw new ConflictError('Only a draft can be cancelled');
        this.status = 'cancelled';
    }
}
