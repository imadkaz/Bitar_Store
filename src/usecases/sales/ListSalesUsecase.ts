import { AuthContext } from '../../models/AuthContext';
import { ISaleRepository, SaleView } from '../../repositories/interfaces/ISaleRepository';
import { BUSINESS_TIME_ZONE, businessDateOf, isRealDate } from '../../utils/businessDate';
import { ForbiddenError } from '../../utils/exeptions/ForbiddenError';
import { ValidationError } from '../../utils/exeptions/ValidationError';
import { isUuid } from '../../utils/uuid';
import { resolvePaging } from '../styles/paging';

export interface ListSalesInput {
    branchId?: unknown;
    date?: unknown;       // YYYY-MM-DD, the shop's day. Default: today.
    limit?: unknown;
    offset?: unknown;
}

export class ListSalesUsecase {
    constructor(
        private readonly saleRepository: ISaleRepository,
        private readonly now: () => Date = () => new Date(),
    ) {}

    async execute(input: ListSalesInput, auth: AuthContext): Promise<{ businessDate: string; sales: SaleView[] }> {
        if (typeof input.branchId !== 'string' || !isUuid(input.branchId)) throw new ValidationError('branchId is required');
        if (!auth.canAccessBranch(input.branchId)) throw new ForbiddenError('You cannot see the sales of this branch');

        let businessDate = businessDateOf(this.now(), BUSINESS_TIME_ZONE);
        if (input.date !== undefined) {
            if (typeof input.date !== 'string' || !isRealDate(input.date)) throw new ValidationError('date must be a real date like 2026-10-27');
            businessDate = input.date;
        }
        const { limit, offset } = resolvePaging(input.limit, input.offset);
        return { businessDate, sales: await this.saleRepository.list({ branchId: input.branchId, businessDate, limit, offset }) };
    }
}
