import { AuthContext } from '../../models/AuthContext';
import { ISaleRepository, SaleView } from '../../repositories/interfaces/ISaleRepository';
import { NotFoundError } from '../../utils/exeptions/NotFoundError';

export class GetSaleUsecase {
    constructor(private readonly saleRepository: ISaleRepository) {}

    // A sale of a branch you cannot reach looks exactly like a sale that does not exist.
    async execute(id: string, auth: AuthContext): Promise<SaleView> {
        const sale = await this.saleRepository.findById(id);
        if (!sale || !auth.canAccessBranch(sale.branchId)) throw new NotFoundError('Sale not found');
        return sale;
    }
}
