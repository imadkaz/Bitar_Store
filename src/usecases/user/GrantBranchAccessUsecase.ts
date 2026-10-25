import { IBranchRepository } from '../../repositories/interfaces/IBranchRepository';
import { IUserAccessRepository } from '../../repositories/interfaces/IUserAccessRepository';
import { IUserRepository } from '../../repositories/interfaces/IUserRepository';
import { ConflictError } from '../../utils/exeptions/ConflictError';
import { NotFoundError } from '../../utils/exeptions/NotFoundError';

export class GrantBranchAccessUsecase {
    constructor(
        private readonly userRepository: IUserRepository,
        private readonly branchRepository: IBranchRepository,
        private readonly userAccessRepository: IUserAccessRepository,
    ) {}

    async execute(userId: string, branchId: string, actorId: string): Promise<void> {
        if (!(await this.userRepository.findById(userId))) throw new NotFoundError('User not found');

        const branch = await this.branchRepository.findById(branchId);
        if (!branch) throw new NotFoundError('Branch not found');
        if (!branch.isActive()) throw new ConflictError('Cannot grant access to an inactive branch');

        await this.userAccessRepository.grantBranch(userId, branchId, actorId);
    }
}
