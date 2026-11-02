import { ValidationError } from '../utils/exeptions/ValidationError';
import { isUuid } from '../utils/uuid';

export const ADJUSTMENT_REASONS = ['count_correction', 'damage', 'loss', 'found', 'data_entry_error', 'other'] as const;
export type AdjustmentReason = (typeof ADJUSTMENT_REASONS)[number];
// The pieces on the road belong to a transfer (receive or confirm lost), never to an adjustment.
export const ADJUSTABLE_BUCKETS = ['sellable', 'non_sellable'] as const;
export type AdjustableBucket = (typeof ADJUSTABLE_BUCKETS)[number];
export const MAX_ADJUSTMENT = 100_000;

export interface AdjustmentRequest {
    branchId: string;
    skuId: string;
    bucket: AdjustableBucket;
    quantityDelta: number;       // + adds pieces, - takes pieces out
    reason: AdjustmentReason;
    note: string;
}

export interface PlannedMove { bucket: AdjustableBucket; delta: number }

function asObject(body: unknown): Record<string, unknown> {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new ValidationError('The request body is required');
    return body as Record<string, unknown>;
}

// What the client sent, checked and made exact. Pure: no database here.
export function parseAdjustment(body: unknown): AdjustmentRequest {
    const input = asObject(body);
    if (typeof input.branchId !== 'string' || !isUuid(input.branchId)) throw new ValidationError('branchId must be a valid id');
    if (typeof input.skuId !== 'string' || !isUuid(input.skuId)) throw new ValidationError('skuId must be a valid id');
    const bucket = input.bucket === undefined ? 'sellable' : input.bucket;
    if (!ADJUSTABLE_BUCKETS.includes(bucket as AdjustableBucket)) throw new ValidationError('bucket must be "sellable" or "non_sellable": the pieces on the road belong to a transfer');
    const delta = input.quantityDelta;
    if (typeof delta !== 'number' || !Number.isInteger(delta) || delta === 0 || Math.abs(delta) > MAX_ADJUSTMENT) {
        throw new ValidationError(`quantityDelta must be a whole number other than 0 (up to ${MAX_ADJUSTMENT}, negative to take pieces out)`);
    }
    if (!ADJUSTMENT_REASONS.includes(input.reason as AdjustmentReason)) throw new ValidationError(`reason must be one of: ${ADJUSTMENT_REASONS.join(', ')}`);
    if (typeof input.note !== 'string' || input.note.trim().length < 5 || input.note.trim().length > 200) throw new ValidationError('note is required: 5 to 200 characters saying what happened');
    return { branchId: input.branchId, skuId: input.skuId, bucket: bucket as AdjustableBucket, quantityDelta: delta, reason: input.reason as AdjustmentReason, note: input.note.trim() };
}

// The stock changes of an adjustment.
//   found: only adds · loss: only takes out · damage: only takes out, and damaged pieces that were for sale go ON HOLD (they are not gone)
export function planAdjustment(request: AdjustmentRequest): PlannedMove[] {
    const { reason, quantityDelta: delta, bucket } = request;
    if (reason === 'found' && delta < 0) throw new ValidationError('"found" adds pieces: quantityDelta must be positive');
    if ((reason === 'loss' || reason === 'damage') && delta > 0) throw new ValidationError(`"${reason}" takes pieces out: quantityDelta must be negative`);
    if (reason === 'damage' && bucket === 'sellable') {
        return [{ bucket: 'sellable', delta }, { bucket: 'non_sellable', delta: -delta }];
    }
    return [{ bucket, delta }];
}
