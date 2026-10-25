// src/usecases/user/UpdateUserUsecase.ts
import { hash } from 'bcrypt';
import { User, UserRole, assertValidPassword, normalizeEmail } from '../../models/User.model';
import { IUserRepository } from '../../repositories/interfaces/IUserRepository';
import { ConflictError } from '../../utils/exeptions/ConflictError';
import { NotFoundError } from '../../utils/exeptions/NotFoundError';
import { ValidationError } from '../../utils/exeptions/ValidationError';

export interface UpdateUserInput {
    id: string;
    email?: string;
    password?: string;   // PLAIN password; hashed here
    fullName?: string;
    role?: UserRole;
    isActive?: boolean;
}

export class UpdateUserUsecase {
    constructor(private readonly userRepository: IUserRepository) {}

    async execute(input: UpdateUserInput, actorId: string): Promise<User> {
        const user = await this.userRepository.findById(input.id);
        if (!user) throw new NotFoundError('User not found');

        if (input.isActive !== undefined && typeof input.isActive !== 'boolean') {
            throw new ValidationError('isActive must be true or false');
        }

        // An admin can't demote or deactivate themselves. Together with "only admins manage users"
        // this guarantees there is always at least one active admin.
        const demotesSelf = input.role !== undefined && input.role !== user.getRole();
        const deactivatesSelf = input.isActive === false;
        if (user.getId() === actorId && (demotesSelf || deactivatesSelf)) {
            throw new ConflictError('You cannot change your own role or deactivate your own account');
        }

        // ONE style: change the entity you loaded, then save that same entity.
        if (input.email !== undefined) {
            const email = normalizeEmail(input.email);
            if (email !== user.getEmail()) {
                const taken = await this.userRepository.findByEmail(email);
                if (taken && taken.getId() !== user.getId()) {
                    throw new ConflictError('A user with this email already exists');
                }
                user.changeEmail(email);
            }
        }
        if (input.password !== undefined) {
            assertValidPassword(input.password);
            user.changePasswordHash(await hash(input.password, 10));
        }
        if (input.fullName !== undefined) user.rename(input.fullName);
        if (input.role !== undefined) user.changeRole(input.role);
        if (input.isActive === false && user.isActive()) user.deactivate();
        if (input.isActive === true && !user.isActive()) user.activate();

        return this.userRepository.update(user, actorId);
    }
}