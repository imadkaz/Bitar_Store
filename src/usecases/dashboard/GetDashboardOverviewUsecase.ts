import { AuthContext } from '../../models/AuthContext';
import { IDashboardRepository } from '../../repositories/interfaces/IDashboardRepository';
import { IBranchRepository } from '../../repositories/interfaces/IBranchRepository';
import { formatCents } from '../../models/Money';
import { businessDateOf } from '../../utils/businessDate';
import { ForbiddenError } from '../../utils/exeptions/ForbiddenError';
import { resolveBranchScope } from '../insight/scope';

export class GetDashboardOverviewUsecase {
    constructor(
        private readonly branches: IBranchRepository,
        private readonly dashboard: IDashboardRepository,
        private readonly now: () => Date = () => new Date(),
    ) {}

    async execute(input: { branchId?: unknown }, auth: AuthContext) {
        if (!auth.can('reports.financial')) throw new ForbiddenError('Missing permission: reports.financial');
        const scope = await resolveBranchScope(auth, input.branchId, this.branches, { onlyBranches: false });
        const data = await this.dashboard.overview(scope.map((branch) => branch.getId()), businessDateOf(this.now()));
        return {
            stock: data.stock,
            locations: data.locations,
            today: { docs: data.today.docs, revenue: formatCents(data.today.revenueCents) },
        };
    }
}
