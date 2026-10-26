import { IBarcodeRepository } from '../../repositories/interfaces/IBarcodeRepository';
import { NotFoundError } from '../../utils/exeptions/NotFoundError';

export class RemoveBarcodeUsecase {
    constructor(private readonly barcodeRepository: IBarcodeRepository) {}

    async execute(id: string): Promise<void> {
        if (!(await this.barcodeRepository.findById(id))) throw new NotFoundError('Barcode not found');
        await this.barcodeRepository.delete(id);
    }
}
