import { ValidationError } from '../../utils/exeptions/ValidationError';

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

// Lists never return "everything": a catalog can have thousands of rows.
export function resolvePaging(limit: unknown, offset: unknown): { limit: number; offset: number } {
    const resolvedLimit = limit === undefined ? DEFAULT_LIMIT : limit;
    const resolvedOffset = offset === undefined ? 0 : offset;
    if (!Number.isInteger(resolvedLimit) || (resolvedLimit as number) < 1 || (resolvedLimit as number) > MAX_LIMIT) {
        throw new ValidationError(`limit must be a whole number between 1 and ${MAX_LIMIT}`);
    }
    if (!Number.isInteger(resolvedOffset) || (resolvedOffset as number) < 0) {
        throw new ValidationError('offset must be a whole number, zero or greater');
    }
    return { limit: resolvedLimit as number, offset: resolvedOffset as number };
}

export function resolveSearch(search: unknown): string | undefined {
    if (search === undefined || search === null) return undefined;
    if (typeof search !== 'string') throw new ValidationError('search must be text');
    const trimmed = search.trim();
    if (trimmed.length === 0) return undefined;
    if (trimmed.length > 100) throw new ValidationError('search must be at most 100 characters');
    return trimmed;
}
