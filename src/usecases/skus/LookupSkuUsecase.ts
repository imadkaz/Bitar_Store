import { normalizeBarcode } from '../../models/Barcode.model';
import { normalizeSkuCode } from '../../models/Sku.model';
import { IBarcodeRepository } from '../../repositories/interfaces/IBarcodeRepository';
import { ISkuRepository } from '../../repositories/interfaces/ISkuRepository';
import { NotFoundError } from '../../utils/exeptions/NotFoundError';
import { ValidationError } from '../../utils/exeptions/ValidationError';
import { GetSkuUsecase, SkuDetail } from './GetSkuUsecase';

// What the scanner does at the till: the text it typed is either a barcode or a sku code. Exact match, no guessing.
export class LookupSkuUsecase {
    private readonly getSku: GetSkuUsecase;

    constructor(
        private readonly skuRepository: ISkuRepository,
        private readonly barcodeRepository: IBarcodeRepository,
    ) {
        this.getSku = new GetSkuUsecase(skuRepository, barcodeRepository);
    }

    async execute(code: string): Promise<SkuDetail> {
        if (typeof code !== 'string' || code.trim().length === 0) throw new ValidationError('code is required');

        const byBarcode = await this.skuRepository.findByBarcode(normalizeBarcode(code));
        if (byBarcode) return this.getSku.execute(byBarcode.sku.getId());

        let skuCode: string;
        try {
            skuCode = normalizeSkuCode(code);
        } catch {
            throw new NotFoundError('No sku matches this code');
        }
        const bySkuCode = await this.skuRepository.findBySkuCode(skuCode);
        if (!bySkuCode) throw new NotFoundError('No sku matches this code');
        return this.getSku.execute(bySkuCode.getId());
    }
}
