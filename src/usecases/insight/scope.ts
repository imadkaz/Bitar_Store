import { AuthContext } from '../../models/AuthContext';
import { Branch } from '../../models/Branch.model';
import { IBranchRepository } from '../../repositories/interfaces/IBranchRepository';
import { isRealDate, businessDateOf } from '../../utils/businessDate';
import { ForbiddenError } from '../../utils/exeptions/ForbiddenError';
import { NotFoundError } from '../../utils/exeptions/NotFoundError';
import { ValidationError } from '../../utils/exeptions/ValidationError';
import { isUuid } from '../../utils/uuid';

export const MAX_RANGE_DAYS = 366;

export function parseRequiredUuid(value: unknown, label: string): string {
    if (typeof value !== 'string' || !isUuid(value)) throw new ValidationError(`${label} must be a valid id`);
    return value;
}

export function parseOptionalUuid(value: unknown, label: string): string | undefined {
    return value === undefined ? undefined : parseRequiredUuid(value, label);
}

export function parseShopDay(value: unknown, label: string): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !isRealDate(value)) throw new ValidationError(`${label} must be a real date like 2026-10-27`);
    return value;
}

export function parseSlug(value: unknown, label: string): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !/^[a-z_]{1,40}$/.test(value)) throw new ValidationError(`${label} must be lower-case letters and "_"`);
    return value;
}

// A report covers whole shop days. No dates means today. The range is limited so one request cannot read the whole history.
export function parseDateRange(fromRaw: unknown, toRaw: unknown, now: Date): { from: string; to: string } {
    const today = businessDateOf(now);
    const from = parseShopDay(fromRaw, 'from') ?? parseShopDay(toRaw, 'to') ?? today;
    const to = parseShopDay(toRaw, 'to') ?? (fromRaw === undefined ? today : from);
    if (from > to) throw new ValidationError('from cannot be after to');
    const days = (Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10)) - Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10))) / 86_400_000 + 1;
    if (days > MAX_RANGE_DAYS) throw new ValidationError(`A report can cover at most ${MAX_RANGE_DAYS} days`);
    return { from, to };
}

// The places a person may look at. One branch when they name it (and may reach it); otherwise every place they reach:
// the admin all of them, a manager only the branches granted to them.
export async function resolveBranchScope(auth: AuthContext, branchIdRaw: unknown, branches: IBranchRepository, options: { onlyBranches: boolean }): Promise<Branch[]> {
    const keep = (list: Branch[]) => list.filter((b) => b.isActive() && (!options.onlyBranches || !b.isWarehouse()));
    if (branchIdRaw !== undefined) {
        const branchId = parseRequiredUuid(branchIdRaw, 'branchId');
        if (!auth.canAccessBranch(branchId)) throw new ForbiddenError('You cannot see this branch');
        const branch = await branches.findById(branchId);
        if (!branch) throw new NotFoundError('Branch not found');
        return options.onlyBranches && branch.isWarehouse() ? [] : [branch];
    }
    return keep(auth.isAdmin() ? await branches.list() : await branches.findByIds(auth.getBranchIds()));
}
