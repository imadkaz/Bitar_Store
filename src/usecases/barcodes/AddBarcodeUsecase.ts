import { randomUUID } from 'node:crypto';
import { Barcode, normalizeBarcode } from '../../models/Barcode.model';
import { IBarcodeRepository } from '../../repositories/interfaces/IBarcodeRepository';
import { ISkuRepository } from '../../repositories/interfaces/ISkuRepository';
import { ConflictError } from '../../utils/exeptions/ConflictError';
import { NotFoundError } from '../../utils/exeptions/NotFoundError';

export class AddBarcodeUsecase {
    constructor(
        private readonly skuRepository: ISkuRepository,
        private readonly barcodeRepository: IBarcodeRepository,
    ) {}

    async execute(skuId: string, code: string, actorId: string): Promise<Barcode> {
        if (!(await this.skuRepository.findById(skuId))) throw new NotFoundError('Sku not found');

        const normalized = normalizeBarcode(code);
        if (await this.barcodeRepository.findByCode(normalized)) {
            throw new ConflictError('This barcode already belongs to a sku');
        }
        return this.barcodeRepository.save(Barcode.create({ id: randomUUID(), skuId, code: normalized }), actorId);
    }
}
