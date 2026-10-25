import { IUserAccessRepository } from '../../repositories/interfaces/IUserAccessRepository';
import { IUserRepository } from '../../repositories/interfaces/IUserRepository';
import { NotFoundError } from '../../utils/exeptions/NotFoundError';

export class RevokeBranchAccessUsecase {
    constructor(
        private readonly userRepository: IUserRepository,
        private readonly userAccessRepository: IUserAccessRepository,
    ) {}

    async execute(userId: string, branchId: string): Promise<void> {
        if (!(await this.userRepository.findById(userId))) throw new NotFoundError('User not found');
        await this.userAccessRepository.revokeBranch(userId, branchId);
    }
}
