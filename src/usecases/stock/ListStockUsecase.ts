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
        return (await this.executePage(input, auth)).items;
    }

    // one page of the list, and how many items the whole list has (for "page 2 of 7" or "load more")
    async executePage(input: ListStockInput, auth: AuthContext): Promise<{ items: StockItem[]; total: number }> {
        if (typeof input.branchId !== 'string' || !isUuid(input.branchId)) throw new ValidationError('branchId is required');
        if (!auth.canAccessBranch(input.branchId)) throw new ForbiddenError('You cannot see the stock of this branch');

        const { limit, offset } = resolvePaging(input.limit, input.offset);
        const filter = { styleId: input.styleId, search: resolveSearch(input.search), activeOnly: input.activeOnly ?? false };
        const [skus, total] = await Promise.all([
            this.skuRepository.list({ ...filter, limit, offset }),
            this.skuRepository.count(filter),
        ]);
        const levels = await this.stockRepository.getLevels(input.branchId, skus.map((s) => s.sku.getId()));
        return { items: skus.map((sku) => ({ sku, level: levels.get(sku.sku.getId())! })), total };
    }
}