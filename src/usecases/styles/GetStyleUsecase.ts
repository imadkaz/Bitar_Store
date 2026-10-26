import { Sku } from '../../models/Sku.model';
import { Style } from '../../models/Style.model';
import { ISkuRepository } from '../../repositories/interfaces/ISkuRepository';
import { IStyleRepository } from '../../repositories/interfaces/IStyleRepository';
import { NotFoundError } from '../../utils/exeptions/NotFoundError';

export class GetStyleUsecase {
    constructor(
        private readonly styleRepository: IStyleRepository,
        private readonly skuRepository: ISkuRepository,
    ) {}

    // a style together with all its variants (skus)
    async execute(id: string): Promise<{ style: Style; skus: Sku[] }> {
        const style = await this.styleRepository.findById(id);
        if (!style) throw new NotFoundError('Style not found');
        const skus = await this.skuRepository.listByStyle(id);
        return { style, skus };
    }
}
