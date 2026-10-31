import { ValidationError } from '../utils/exeptions/ValidationError';

export const MAX_LEVEL = 1_000_000;

// The minimum a branch should keep of a sku, and optionally the quantity to fill it back up to.
// Database CHECKs: min >= 0, target is NULL or >= min.
export function parseReorderQuantities(min: unknown, target: unknown): { min: number; target: number | null } {
    if (typeof min !== 'number' || !Number.isInteger(min) || min < 0 || min > MAX_LEVEL) {
        throw new ValidationError(`minQuantity must be a whole number from 0 to ${MAX_LEVEL}`);
    }
    if (target === undefined || target === null) return { min, target: null };
    if (typeof target !== 'number' || !Number.isInteger(target) || target > MAX_LEVEL) {
        throw new ValidationError(`targetQuantity must be a whole number up to ${MAX_LEVEL}`);
    }
    if (target < min) throw new ValidationError('targetQuantity cannot be below minQuantity');
    return { min, target };
}

// What to send: bring the branch back up to the target (or to the minimum when no target is set).
export function suggestedQuantity(sellable: number, inTransit: number, min: number, target: number | null): number {
    const have = sellable + inTransit;
    if (have >= min) return 0;
    return (target ?? min) - have;
}
