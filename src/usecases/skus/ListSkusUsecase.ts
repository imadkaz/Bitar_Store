import { ISkuRepository, SkuWithStyle } from '../../repositories/interfaces/ISkuRepository';
import { resolvePaging, resolveSearch } from '../styles/paging';

export interface ListSkusInput {
    styleId?: string;
    search?: string;
    activeOnly?: boolean;
    limit?: number;
    offset?: number;
}

export class ListSkusUsecase {
    constructor(private readonly skuRepository: ISkuRepository) {}

    async execute(input: ListSkusInput): Promise<SkuWithStyle[]> {
        const { limit, offset } = resolvePaging(input.limit, input.offset);
        return this.skuRepository.list({
            styleId: input.styleId,
            search: resolveSearch(input.search),
            activeOnly: input.activeOnly ?? false,
            limit,
            offset,
        });
    }
}
