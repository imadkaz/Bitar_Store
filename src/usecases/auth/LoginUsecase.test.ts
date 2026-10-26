import { hash } from 'bcrypt';
import { beforeAll, describe, expect, it } from 'vitest';
import { UserRole } from '../../models/User.model';
import { JwtTokenService } from '../../services/JwtTokenService';
import { FakeUserRepository, makeUser } from '../../test-helpers/fakes';
import { UnauthorizedError } from '../../utils/exeptions/UnauthorizedError';
import { ValidationError } from '../../utils/exeptions/ValidationError';
import { LoginUsecase } from './LoginUsecase';

describe('LoginUsecase', () => {
    const tokens = new JwtTokenService('test-secret-test-secret-test-secret-123456', '1h');
    let useCase: LoginUsecase;
    let sara = makeUser();

    beforeAll(async () => {
        const passwordHash = await hash('Password#123', 4);   // cost 4 only to keep the test fast
        sara = makeUser({ email: 'sara@bitar.test', passwordHash });
        const inactive = makeUser({ email: 'off@bitar.test', passwordHash, isActive: false });
        const noPassword = makeUser({ email: 'nopass@bitar.test', passwordHash: null, role: UserRole.MANAGER });
        useCase = new LoginUsecase(new FakeUserRepository([sara, inactive, noPassword]), tokens);
    });

    it('returns a token that identifies the user', async () => {
        const { token, user } = await useCase.execute({ email: 'sara@bitar.test', password: 'Password#123' });
        expect(user.getId()).toBe(sara.getId());
        expect(tokens.verify(token)).toBe(sara.getId());
    });

    it('matches the email case-insensitively and ignores surrounding spaces', async () => {
        const { user } = await useCase.execute({ email: '  SARA@Bitar.Test ', password: 'Password#123' });
        expect(user.getId()).toBe(sara.getId());
    });

    it('gives the SAME error for a wrong password, an unknown email and a malformed email', async () => {
        const wrong = await useCase.execute({ email: 'sara@bitar.test', password: 'nope' }).catch((e) => e);
        const unknown = await useCase.execute({ email: 'ghost@bitar.test', password: 'nope' }).catch((e) => e);
        const malformed = await useCase.execute({ email: 'not-an-email', password: 'nope' }).catch((e) => e);
        for (const error of [wrong, unknown, malformed]) expect(error).toBeInstanceOf(UnauthorizedError);
        expect(new Set([wrong.message, unknown.message, malformed.message]).size).toBe(1);
    });

    it('refuses a deactivated user even with the right password', async () => {
        await expect(useCase.execute({ email: 'off@bitar.test', password: 'Password#123' })).rejects.toBeInstanceOf(UnauthorizedError);
    });

    it('refuses a user who has no password yet', async () => {
        await expect(useCase.execute({ email: 'nopass@bitar.test', password: 'anything' })).rejects.toBeInstanceOf(UnauthorizedError);
    });

    it('asks for both fields (400) when they are missing or not text', async () => {
        await expect(useCase.execute({ email: 'sara@bitar.test', password: '' })).rejects.toBeInstanceOf(ValidationError);
        await expect(useCase.execute({ email: undefined, password: 'x' })).rejects.toBeInstanceOf(ValidationError);
        await expect(useCase.execute({ email: 'sara@bitar.test', password: 12345678 })).rejects.toBeInstanceOf(ValidationError);
    });
});
