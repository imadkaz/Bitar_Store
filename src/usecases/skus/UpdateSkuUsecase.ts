import { Sku } from '../../models/Sku.model';
import { ISkuRepository } from '../../repositories/interfaces/ISkuRepository';
import { ConflictError } from '../../utils/exeptions/ConflictError';
import { NotFoundError } from '../../utils/exeptions/NotFoundError';
import { ValidationError } from '../../utils/exeptions/ValidationError';

export interface UpdateSkuInput {
    id: string;
    size?: string;
    color?: string;
    isActive?: boolean;
}

// The sku code, the currency and the price are NOT changed here (the price has its own use case, with a history).
export class UpdateSkuUsecase {
    constructor(private readonly skuRepository: ISkuRepository) {}

    async execute(input: UpdateSkuInput, actorId: string): Promise<Sku> {
        const sku = await this.skuRepository.findById(input.id);
        if (!sku) throw new NotFoundError('Sku not found');

        if (input.size !== undefined) sku.changeSize(input.size);
        if (input.color !== undefined) sku.changeColor(input.color);
        if (input.isActive !== undefined) {
            if (typeof input.isActive !== 'boolean') throw new ValidationError('isActive must be true or false');
            if (input.isActive) sku.activate();
            else sku.deactivate();
        }
        
        const variant = await this.skuRepository.findByVariant(sku.getStyleId(), sku.getSize(), sku.getColor(), sku.getId());
        if (input.size !== undefined || input.color !== undefined) {
            if (variant) {
                throw new ConflictError('This style already has a sku with the same size and color');
            }
        }
        return this.skuRepository.update(sku, actorId);
    }
}
