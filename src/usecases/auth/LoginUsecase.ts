import { compare, hash } from 'bcrypt';
import { randomUUID } from 'node:crypto';
import { User, normalizeEmail } from '../../models/User.model';
import { IUserRepository } from '../../repositories/interfaces/IUserRepository';
import { ITokenService } from '../../services/interfaces/ITokenService';
import { UnauthorizedError } from '../../utils/exeptions/UnauthorizedError';
import { ValidationError } from '../../utils/exeptions/ValidationError';

export interface LoginInput {
    email: unknown;
    password: unknown;
}

export interface LoginResult {
    token: string;
    user: User;
}

const INVALID_CREDENTIALS = 'Invalid email or password';

export class LoginUsecase {
    private dummyHash: string | null = null;

    constructor(
        private readonly userRepository: IUserRepository,
        private readonly tokenService: ITokenService,
    ) {}

    async execute(input: LoginInput): Promise<LoginResult> {
        if (typeof input.email !== 'string' || typeof input.password !== 'string' || input.password.length === 0) {
            throw new ValidationError('Email and password are required');
        }

        let email: string;
        try {
            email = normalizeEmail(input.email);
        } catch {
            throw new UnauthorizedError(INVALID_CREDENTIALS);   // a malformed email is just "wrong credentials"
        }

        const user = await this.userRepository.findByEmail(email);
        const storedHash = user?.getPasswordHash() ?? null;

        // Always run exactly one bcrypt comparison, even for unknown emails or users without a password,
        // so the response time doesn't reveal which emails exist.
        const passwordOk = await compare(input.password, storedHash ?? (await this.getDummyHash()));

        if (!user || !storedHash || !passwordOk || !user.isActive()) {
            throw new UnauthorizedError(INVALID_CREDENTIALS);   // the SAME message for every failure
        }

        return { token: this.tokenService.sign(user.getId()), user };
    }

    private async getDummyHash(): Promise<string> {
        if (!this.dummyHash) this.dummyHash = await hash(randomUUID(), 10);
        return this.dummyHash;
    }
}
