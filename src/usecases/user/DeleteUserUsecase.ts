import { IUserRepository } from '../../repositories/interfaces/IUserRepository';
import { ConflictError } from '../../utils/exeptions/ConflictError';
import { NotFoundError } from '../../utils/exeptions/NotFoundError';

// Permanent delete. It works only for users nothing else refers to (for example one created by mistake).
// A user who has done anything (created records, sold, moved stock) is refused by the database: deactivate them instead.
export class DeleteUserUsecase {
    constructor(private readonly userRepository: IUserRepository) {}

    async execute(userId: string, actorId: string): Promise<void> {
        const user = await this.userRepository.findById(userId);
        if (!user) throw new NotFoundError('User not found');
        if (user.getId() === actorId) throw new ConflictError('You cannot delete your own account');

        await this.userRepository.delete(userId, actorId);   // ConflictError if the user has history
    }
}
