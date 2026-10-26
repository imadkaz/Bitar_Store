import { Style } from '../../models/Style.model';
import { IStyleRepository } from '../../repositories/interfaces/IStyleRepository';
import { resolvePaging, resolveSearch } from './paging';

export interface ListStylesInput {
    search?: string;
    activeOnly?: boolean;
    limit?: number;
    offset?: number;
}

export class ListStylesUsecase {
    constructor(private readonly styleRepository: IStyleRepository) {}

    async execute(input: ListStylesInput): Promise<Style[]> {
        const { limit, offset } = resolvePaging(input.limit, input.offset);
        return this.styleRepository.list({ search: resolveSearch(input.search), activeOnly: input.activeOnly ?? false, limit, offset });
    }
}
