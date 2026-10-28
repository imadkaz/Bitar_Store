import { AuthContext } from '../../models/AuthContext';
import { ISkuRepository, SkuWithStyle } from '../../repositories/interfaces/ISkuRepository';
import { IStockRepository, StockLevel } from '../../repositories/interfaces/IStockRepository';
import { ForbiddenError } from '../../utils/exeptions/ForbiddenError';
import { ValidationError } from '../../utils/exeptions/ValidationError';
import { isUuid } from '../../utils/uuid';
import { resolvePaging, resolveSearch } from '../styles/paging';

export interface ListStockInput {
    branchId?: unknown;
    search?: unknown;
    styleId?: string;
    activeOnly?: boolean;
    limit?: unknown;
    offset?: unknown;
}

export interface StockItem {
    sku: SkuWithStyle;
    level: StockLevel;
}

// "Do we have it, and how many?" for ONE branch. Every catalog variant is listed, with 0 when there is no stock.
export class ListStockUsecase {
    constructor(
        private readonly skuRepository: ISkuRepository,
        private readonly stockRepository: IStockRepository,
    ) {}

    async execute(input: ListStockInput, auth: AuthContext): Promise<StockItem[]> {
        if (typeof input.branchId !== 'string' || !isUuid(input.branchId)) throw new ValidationError('branchId is required');
        if (!auth.canAccessBranch(input.branchId)) throw new ForbiddenError('You cannot see the stock of this branch');

        const { limit, offset } = resolvePaging(input.limit, input.offset);
        const skus = await this.skuRepository.list({ styleId: input.styleId, search: resolveSearch(input.search), activeOnly: input.activeOnly ?? false, limit, offset });
        const levels = await this.stockRepository.getLevels(input.branchId, skus.map((s) => s.sku.getId()));
        return skus.map((sku) => ({ sku, level: levels.get(sku.sku.getId())! }));
    }
}
