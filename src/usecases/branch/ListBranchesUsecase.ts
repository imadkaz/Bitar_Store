import { AuthContext } from '../../models/AuthContext';
import { Branch } from '../../models/Branch.model';
import { IBranchRepository } from '../../repositories/interfaces/IBranchRepository';

export class ListBranchesUsecase {
    constructor(private readonly branchRepository: IBranchRepository) {}

    // admins see every branch (including inactive ones); everyone else only their active, granted branches
    async execute(auth: AuthContext): Promise<Branch[]> {
        if (auth.isAdmin()) return this.branchRepository.list();
        const branches = await this.branchRepository.findByIds(auth.getBranchIds());
        return branches.filter((b) => b.isActive());
    }
}
