import { AuthContext } from '../../models/AuthContext';
import { IBranchRepository } from '../../repositories/interfaces/IBranchRepository';
import { SaleHistoryRow, SalesHistoryRepository } from '../../repositories/SalesHistoryRepository';
import { resolvePaging } from '../styles/paging';
import { parseDateRange, resolveBranchScope } from '../insight/scope';

// Sales history: today, last week, last year. Anyone sees the sales of the branches they reach; the admin sees every branch.
export class ListSalesHistoryUsecase {
    constructor(private readonly branches: IBranchRepository, private readonly history: SalesHistoryRepository, private readonly now: () => Date = () => new Date()) {}

    async execute(input: { branchId?: unknown; from?: unknown; to?: unknown; limit?: unknown; offset?: unknown }, auth: AuthContext): Promise<{ from: string; to: string; rows: SaleHistoryRow[]; total: number }> {
        const { from, to } = parseDateRange(input.from, input.to, this.now());
        const { limit, offset } = resolvePaging(input.limit, input.offset);
        const scope = await resolveBranchScope(auth, input.branchId, this.branches, { onlyBranches: true });
        const { rows, total } = await this.history.list(scope.map((b) => b.getId()), from, to, limit, offset);
        return { from, to, rows, total };
    }
}
