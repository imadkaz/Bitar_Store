// src/usecases/user/CreateUserUsecase.ts
import { randomUUID } from 'node:crypto';
import { User, UserRole, normalizeEmail } from '../../models/User.model';
import { IUserRepository } from '../../repositories/interfaces/IUserRepository';
import { ConflictError } from '../../utils/exeptions/ConflictError';

export interface CreateUserInput {
    email: string;
    fullName: string;
    role: UserRole;
    // no password: the user is created WITHOUT one and cannot log in until an admin sets it (SetUserPasswordUsecase)
}

export class CreateUserUsecase {
    constructor(private readonly userRepository: IUserRepository) {}

    async execute(input: CreateUserInput, actorId: string | null): Promise<User> {
        const email = normalizeEmail(input.email);

        if (await this.userRepository.findByEmail(email)) {
            throw new ConflictError('A user with this email already exists');
        }

        const user = User.create({ id: randomUUID(), email, fullName: input.fullName, role: input.role });
        return this.userRepository.create(user, actorId);
    }
}