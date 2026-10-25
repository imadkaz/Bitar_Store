// src/usecases/user/CreateUserUsecase.ts
import { hash } from 'bcrypt';
import { randomUUID } from 'node:crypto';
import { User, UserRole, assertValidPassword, normalizeEmail } from '../../models/User.model';
import { IUserRepository } from '../../repositories/interfaces/IUserRepository';
import { ConflictError } from '../../utils/exeptions/ConflictError';

export interface CreateUserInput {
    email: string;
    password: string;   // the PLAIN password; only the hash is ever stored
    fullName: string;
    role: UserRole;
}

export class CreateUserUsecase {
    constructor(private readonly userRepository: IUserRepository) {}

    // actorId is null only for the very first admin (seed script)
    async execute(input: CreateUserInput, actorId: string | null): Promise<User> {
        const email = normalizeEmail(input.email);
        assertValidPassword(input.password);

        if (await this.userRepository.findByEmail(email)) {
            throw new ConflictError('A user with this email already exists');
        }

        const passwordHash = await hash(input.password, 10);
        const user = User.create({
            id: randomUUID(),
            email,
            passwordHash,
            fullName: input.fullName,
            role: input.role,
        });
        return this.userRepository.create(user, actorId);
    }
}