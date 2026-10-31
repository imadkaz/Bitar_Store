import { AuthContext } from '../../models/AuthContext';
import { parseReorderQuantities } from '../../models/ReorderLevel.model';
import { IBranchRepository } from '../../repositories/interfaces/IBranchRepository';
import { IReorderLevelRepository, ReorderLevelView } from '../../repositories/interfaces/IReorderLevelRepository';
import { ISkuRepository } from '../../repositories/interfaces/ISkuRepository';
import { IStyleRepository } from '../../repositories/interfaces/IStyleRepository';
import { ConflictError } from '../../utils/exeptions/ConflictError';
import { ForbiddenError } from '../../utils/exeptions/ForbiddenError';
import { NotFoundError } from '../../utils/exeptions/NotFoundError';
import { ValidationError } from '../../utils/exeptions/ValidationError';
import { resolvePaging, resolveSearch } from '../styles/paging';
import { parseRequiredUuid } from '../insight/scope';

function asObject(body: unknown): Record<string, unknown> {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new ValidationError('The request body is required');
    return body as Record<string, unknown>;
}

// The minimum belongs to a BRANCH. The warehouse is the one that supplies it, so it has no minimum of its own.
async function requireBranchForLevels(auth: AuthContext, branchIdRaw: unknown, branches: IBranchRepository) {
    if (!auth.can('adjustments.create')) throw new ForbiddenError('Missing permission: adjustments.create');
    const branchId = parseRequiredUuid(branchIdRaw, 'branchId');
    if (!auth.canAccessBranch(branchId)) throw new ForbiddenError('You cannot change the minimums of this branch');
    const branch = await branches.findById(branchId);
    if (!branch) throw new NotFoundError('Branch not found');
    return branch;
}

function requireUsableBranch(branch: { isActive(): boolean; isWarehouse(): boolean }) {
    if (!branch.isActive()) throw new ConflictError('This branch is inactive');
    if (branch.isWarehouse()) throw new ConflictError('The warehouse has no minimum: it supplies the branches');
}

export class SetReorderLevelUsecase {
    constructor(private readonly branches: IBranchRepository, private readonly skus: ISkuRepository, private readonly levels: IReorderLevelRepository) {}

    async execute(body: unknown, auth: AuthContext): Promise<ReorderLevelView> {
        const input = asObject(body);
        const branch = await requireBranchForLevels(auth, input.branchId, this.branches);
        const skuId = parseRequiredUuid(input.skuId, 'skuId');
        const { min, target } = parseReorderQuantities(input.minQuantity, input.targetQuantity);
        requireUsableBranch(branch);
        const found = await this.skus.findById(skuId);
        if (!found) throw new NotFoundError('Sku not found');
        if (!found.isActive()) throw new ConflictError('This sku is inactive');
        return this.levels.upsert(branch.getId(), skuId, min, target, auth.user.getId());
    }
}

// "per model": one call sets the same minimum for every active size and color of a style at a branch
export class SetReorderLevelForStyleUsecase {
    constructor(private readonly branches: IBranchRepository, private readonly styles: IStyleRepository, private readonly levels: IReorderLevelRepository) {}

    async execute(body: unknown, auth: AuthContext): Promise<{ styleId: string; skus: number }> {
        const input = asObject(body);
        const branch = await requireBranchForLevels(auth, input.branchId, this.branches);
        const styleId = parseRequiredUuid(input.styleId, 'styleId');
        const { min, target } = parseReorderQuantities(input.minQuantity, input.targetQuantity);
        requireUsableBranch(branch);
        const style = await this.styles.findById(styleId);
        if (!style) throw new NotFoundError('Style not found');
        const count = await this.levels.upsertForStyle(branch.getId(), styleId, min, target, auth.user.getId());
        if (count === 0) throw new ConflictError('This style has no active skus');
        return { styleId, skus: count };
    }
}

export class ListReorderLevelsUsecase {
    constructor(private readonly branches: IBranchRepository, private readonly levels: IReorderLevelRepository) {}

    async execute(input: { branchId?: unknown; search?: unknown; limit?: unknown; offset?: unknown }, auth: AuthContext): Promise<ReorderLevelView[]> {
        const branch = await requireBranchForLevels(auth, input.branchId, this.branches);
        const { limit, offset } = resolvePaging(input.limit, input.offset);
        return this.levels.list({ branchId: branch.getId(), search: resolveSearch(input.search), limit, offset });
    }
}

export class DeleteReorderLevelUsecase {
    constructor(private readonly levels: IReorderLevelRepository) {}

    // a minimum of a branch you cannot reach looks like a minimum that does not exist
    async execute(id: string, auth: AuthContext): Promise<void> {
        if (!auth.can('adjustments.create')) throw new ForbiddenError('Missing permission: adjustments.create');
        const level = await this.levels.findById(id);
        if (!level || !auth.canAccessBranch(level.branchId)) throw new NotFoundError('Minimum not found');
        await this.levels.delete(id, auth.user.getId());
    }
}
