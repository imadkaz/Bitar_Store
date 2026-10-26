import { AuthContext } from '../../models/AuthContext';
import { resolvePermissions } from '../../models/Permission';
import { IUserAccessRepository } from '../../repositories/interfaces/IUserAccessRepository';
import { IUserRepository } from '../../repositories/interfaces/IUserRepository';
import { UnauthorizedError } from '../../utils/exeptions/UnauthorizedError';

// Runs on every authenticated request: a deactivated user or a changed role takes effect immediately.
export class GetAuthContextUsecase {
    constructor(
        private readonly userRepository: IUserRepository,
        private readonly userAccessRepository: IUserAccessRepository,
    ) {}

    async execute(userId: string): Promise<AuthContext> {
        const user = await this.userRepository.findById(userId);
        if (!user || !user.isActive()) throw new UnauthorizedError('Invalid or expired token');

        const [overrides, branchIds] = await Promise.all([
            this.userAccessRepository.findOverrides(userId),
            this.userAccessRepository.findBranchIds(userId),
        ]);

        return new AuthContext(user, resolvePermissions(user.getRole(), overrides), new Set(branchIds));
    }
}
