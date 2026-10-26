import { Barcode } from '../../models/Barcode.model';
import { IBarcodeRepository } from '../../repositories/interfaces/IBarcodeRepository';
import { ISkuRepository, SkuWithStyle } from '../../repositories/interfaces/ISkuRepository';
import { NotFoundError } from '../../utils/exeptions/NotFoundError';

export interface SkuDetail extends SkuWithStyle {
    barcodes: Barcode[];
}

export class GetSkuUsecase {
    constructor(
        private readonly skuRepository: ISkuRepository,
        private readonly barcodeRepository: IBarcodeRepository,
    ) {}

    async execute(id: string): Promise<SkuDetail> {
        const found = await this.skuRepository.findWithStyleById(id);
        if (!found) throw new NotFoundError('Sku not found');
        return { ...found, barcodes: await this.barcodeRepository.listBySku(id) };
    }
}
