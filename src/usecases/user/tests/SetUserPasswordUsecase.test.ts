import { compare } from 'bcrypt';
import { beforeEach, describe, expect, it } from 'vitest';
import { User, UserRole } from '../../models/User.model';
import { FakeUserRepository, makeUser } from '../../test-helpers/fakes';
import { NotFoundError } from '../../utils/exeptions/NotFoundError';
import { ValidationError } from '../../utils/exeptions/ValidationError';
import { SetUserPasswordUsecase } from './SetUserPasswordUsecase';

describe('SetUserPasswordUsecase', () => {
    let repo: FakeUserRepository;
    let useCase: SetUserPasswordUsecase;
    let admin: User;
    let employee: User;

    beforeEach(() => {
        admin = makeUser({ role: UserRole.ADMIN });
        employee = makeUser({ passwordHash: null, fullName: 'Sara Employee' });   // created without a password
        repo = new FakeUserRepository([admin, employee]);
        useCase = new SetUserPasswordUsecase(repo);
    });

    it('gives a user without a password their first one: stored as a bcrypt hash, never the plain text', async () => {
        expect(employee.hasPassword()).toBe(false);
        await useCase.execute(employee.getId(), 'Password#123', admin.getId());

        const stored = (await repo.findById(employee.getId()))!;
        expect(stored.hasPassword()).toBe(true);
        expect(stored.getPasswordHash()).not.toBe('Password#123');
        expect(await compare('Password#123', stored.getPasswordHash()!)).toBe(true);
    });

    it('the same call resets an existing password: the old one stops matching', async () => {
        await useCase.execute(employee.getId(), 'Password#123', admin.getId());
        await useCase.execute(employee.getId(), 'NewPassword#456', admin.getId());

        const hash = (await repo.findById(employee.getId()))!.getPasswordHash()!;
        expect(await compare('NewPassword#456', hash)).toBe(true);
        expect(await compare('Password#123', hash)).toBe(false);
    });

    it('changes nothing else about the user and records who did it', async () => {
        await useCase.execute(employee.getId(), 'Password#123', admin.getId());
        const stored = (await repo.findById(employee.getId()))!;
        expect(stored.getFullName()).toBe('Sara Employee');
        expect(stored.getEmail()).toBe(employee.getEmail());
        expect(stored.getRole()).toBe(UserRole.EMPLOYEE);
        expect(repo.audit.get(employee.getId())?.updatedBy).toBe(admin.getId());
    });

    it('refuses a bad password (400) and leaves the user without one', async () => {
        for (const bad of ['short', '', undefined, null, 12345678, 'x'.repeat(73)]) {
            await expect(useCase.execute(employee.getId(), bad, admin.getId())).rejects.toBeInstanceOf(ValidationError);
        }
        expect((await repo.findById(employee.getId()))?.hasPassword()).toBe(false);
    });

    it('404 for an unknown user', async () => {
        await expect(useCase.execute('nobody', 'Password#123', admin.getId())).rejects.toBeInstanceOf(NotFoundError);
    });
});
