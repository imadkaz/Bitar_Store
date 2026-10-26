import { randomUUID } from 'node:crypto';
import { parseMoneyToCents } from '../../models/Money';
import { Sku, normalizeSkuCode, validateColor, validateSize } from '../../models/Sku.model';
import { ISkuRepository } from '../../repositories/interfaces/ISkuRepository';
import { IStyleRepository } from '../../repositories/interfaces/IStyleRepository';
import { ConflictError } from '../../utils/exeptions/ConflictError';
import { NotFoundError } from '../../utils/exeptions/NotFoundError';

export interface CreateSkuInput {
    styleId: string;
    skuCode: string;
    size: string;
    color: string;
    standardPrice: string | number;     // "25.00" or 25
    currency?: string;         // defaults to USD
}

export class CreateSkuUsecase {
    constructor(
        private readonly styleRepository: IStyleRepository,
        private readonly skuRepository: ISkuRepository,
    ) {}

    async execute(input: CreateSkuInput, actorId: string): Promise<Sku> {
        const style = await this.styleRepository.findById(input.styleId);
        if (!style) throw new NotFoundError('Style not found');
        if (!style.isActive()) throw new ConflictError('This style is inactive: activate it before adding skus');

        const skuCode = normalizeSkuCode(input.skuCode);
        const size = validateSize(input.size);
        const color = validateColor(input.color);
        const standardPriceCents = parseMoneyToCents(input.standardPrice, 'Standard price');

        if (await this.skuRepository.findBySkuCode(skuCode)) {
            throw new ConflictError('A sku with this code already exists');
        }
        if (await this.skuRepository.findByVariant(style.getId(), size, color)) {
            throw new ConflictError('This style already has a sku with the same size and color');
        }

        const sku = Sku.create({
            id: randomUUID(),
            styleId: style.getId(),
            skuCode,
            size,
            color,
            standardPriceCents,
            currency: input.currency as string | undefined,
        });
        return this.skuRepository.save(sku, actorId);
    }
}
