import { beforeEach, describe, expect, it } from 'vitest';
import { UserRole } from '../../../models/User.model';
import { FakeUserRepository } from '../../../test-helpers/fakes';
import { ConflictError } from '../../../utils/exeptions/ConflictError';
import { ValidationError } from '../../../utils/exeptions/ValidationError';
import { CreateUserUsecase } from '../CreateUserUsecase';

describe('CreateUserUsecase', () => {
    let repo: FakeUserRepository;
    let useCase: CreateUserUsecase;
    const input = { email: ' New.User@Bitar.test ', fullName: 'New User', role: UserRole.EMPLOYEE };

    beforeEach(() => {
        repo = new FakeUserRepository();
        useCase = new CreateUserUsecase(repo);
    });

    it('creates the user WITHOUT a password and normalizes the email', async () => {
        const user = await useCase.execute(input, 'admin-1');
        expect(user.getEmail()).toBe('new.user@bitar.test');
        expect(user.hasPassword()).toBe(false);
        expect(user.getPasswordHash()).toBeNull();
    });

    it('remembers who created the user', async () => {
        const user = await useCase.execute(input, 'admin-1');
        expect(repo.audit.get(user.getId())?.createdBy).toBe('admin-1');
    });

    it('rejects an email that already exists, whatever its letter case', async () => {
        await useCase.execute(input, null);
        await expect(useCase.execute({ ...input, email: 'NEW.USER@bitar.test' }, null)).rejects.toBeInstanceOf(ConflictError);
    });

    it('rejects bad input with a ValidationError (400), never a crash (500)', async () => {
        await expect(useCase.execute({ ...input, email: undefined as never }, null)).rejects.toBeInstanceOf(ValidationError);
        await expect(useCase.execute({ ...input, email: 'not-an-email' }, null)).rejects.toBeInstanceOf(ValidationError);
        await expect(useCase.execute({ ...input, role: 'boss' as never }, null)).rejects.toBeInstanceOf(ValidationError);
        await expect(useCase.execute({ ...input, fullName: ' ' }, null)).rejects.toBeInstanceOf(ValidationError);
    });
});
