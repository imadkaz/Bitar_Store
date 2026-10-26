import { parseMoneyToCents } from '../../models/Money';
import { Sku } from '../../models/Sku.model';
import { ISkuRepository } from '../../repositories/interfaces/ISkuRepository';
import { NotFoundError } from '../../utils/exeptions/NotFoundError';

export class ChangeSkuPriceUsecase {
    constructor(private readonly skuRepository: ISkuRepository) {}

    // Sending the price the sku already has changes nothing and records nothing.
    // History rows only exist for real changes, so "who changed the price, when, from what" stays meaningful.
    async execute(skuId: string, price: string | number, actorId: string): Promise<Sku> {
        const sku = await this.skuRepository.findById(skuId);
        if (!sku) throw new NotFoundError('Sku not found');

        const changed = sku.changePrice(parseMoneyToCents(price, 'Price'));
        if (!changed) return sku;
        return this.skuRepository.changePrice(sku, actorId);
    }
}
