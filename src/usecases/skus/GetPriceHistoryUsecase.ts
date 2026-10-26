import { PriceChange } from '../../models/Sku.model';
import { ISkuRepository } from '../../repositories/interfaces/ISkuRepository';
import { NotFoundError } from '../../utils/exeptions/NotFoundError';
import { resolvePaging } from '../styles/paging';

export class GetPriceHistoryUsecase {
    constructor(private readonly skuRepository: ISkuRepository) {}

    // newest first
    async execute(skuId: string, limit?: number): Promise<PriceChange[]> {
        if (!(await this.skuRepository.findById(skuId))) throw new NotFoundError('Sku not found');
        return this.skuRepository.listPriceHistory(skuId, resolvePaging(limit, undefined).limit);
    }
}
