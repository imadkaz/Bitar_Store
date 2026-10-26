import { hash } from 'bcrypt';
import { assertValidPassword } from '../../models/User.model';
import { IUserRepository } from '../../repositories/interfaces/IUserRepository';
import { NotFoundError } from '../../utils/exeptions/NotFoundError';

// The ONLY way a password gets into the system. The same call sets the first password and resets a forgotten one.
export class SetUserPasswordUsecase {
    constructor(private readonly userRepository: IUserRepository) {}

    // actorId is null only for the very first admin (seed script)
    async execute(userId: string, password: string, actorId: string | null): Promise<void> {
        const user = await this.userRepository.findById(userId);
        if (!user) throw new NotFoundError('User not found');

        assertValidPassword(password);   // 400 on missing / too short / too long, before spending time on hashing
        user.changePasswordHash(await hash(password, 10));
        await this.userRepository.update(user, actorId);
    }
}
