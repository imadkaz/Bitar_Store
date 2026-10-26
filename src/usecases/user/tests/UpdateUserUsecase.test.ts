import { beforeEach, describe, expect, it } from 'vitest';
import { User, UserRole } from '../../../models/User.model';
import { FakeUserRepository, makeUser } from '../../../test-helpers/fakes';
import { ConflictError } from '../../../utils/exeptions/ConflictError';
import { NotFoundError } from '../../../utils/exeptions/NotFoundError';
import { ValidationError } from '../../../utils/exeptions/ValidationError';
import { UpdateUserUsecase } from '../UpdateUserUsecase';

describe('UpdateUserUsecase', () => {
    let repo: FakeUserRepository;
    let useCase: UpdateUserUsecase;
    let admin: User;
    let employee: User;

    beforeEach(() => {
        admin = makeUser({ role: UserRole.ADMIN });
        employee = makeUser({ fullName: 'Sara Employee' });
        repo = new FakeUserRepository([admin, employee]);
        useCase = new UpdateUserUsecase(repo);
    });

    it('SAVES every change (name, role, email): the stored user is what changed', async () => {
        await useCase.execute(
            { id: employee.getId(), fullName: 'Renamed', role: UserRole.MANAGER, email: 'new@bitar.test' },
            admin.getId(),
        );

        const stored = (await repo.findById(employee.getId()))!;
        expect(stored.getFullName()).toBe('Renamed');
        expect(stored.getRole()).toBe(UserRole.MANAGER);
        expect(stored.getEmail()).toBe('new@bitar.test');
        expect(repo.audit.get(employee.getId())?.updatedBy).toBe(admin.getId());
    });

    it('never touches the password, whatever else it changes', async () => {
        const before = employee.getPasswordHash();
        await useCase.execute({ id: employee.getId(), fullName: 'Renamed', email: 'moved@bitar.test', role: UserRole.MANAGER }, admin.getId());
        expect((await repo.findById(employee.getId()))?.getPasswordHash()).toBe(before);
    });

    it('leaves everything else untouched when only one field is sent', async () => {
        const hashBefore = employee.getPasswordHash();
        await useCase.execute({ id: employee.getId(), fullName: 'Only The Name' }, admin.getId());
        const stored = (await repo.findById(employee.getId()))!;
        expect(stored.getEmail()).toBe(employee.getEmail());
        expect(stored.getRole()).toBe(UserRole.EMPLOYEE);
        expect(stored.getPasswordHash()).toBe(hashBefore);
    });

    it('refuses an email that belongs to someone else, but accepts your own email again', async () => {
        await expect(useCase.execute({ id: employee.getId(), email: admin.getEmail() }, admin.getId())).rejects.toBeInstanceOf(ConflictError);
        const same = await useCase.execute({ id: employee.getId(), email: employee.getEmail().toUpperCase() }, admin.getId());
        expect(same.getEmail()).toBe(employee.getEmail());
    });

    it('deactivates (with a date) and reactivates', async () => {
        const off = await useCase.execute({ id: employee.getId(), isActive: false }, admin.getId());
        expect(off.isActive()).toBe(false);
        expect(off.getDeactivatedAt()).toBeInstanceOf(Date);
        const on = await useCase.execute({ id: employee.getId(), isActive: true }, admin.getId());
        expect(on.getDeactivatedAt()).toBeNull();
    });

    it('an admin cannot demote or deactivate themselves, but can still rename themselves', async () => {
        await expect(useCase.execute({ id: admin.getId(), role: UserRole.EMPLOYEE }, admin.getId())).rejects.toBeInstanceOf(ConflictError);
        await expect(useCase.execute({ id: admin.getId(), isActive: false }, admin.getId())).rejects.toBeInstanceOf(ConflictError);
        const renamed = await useCase.execute({ id: admin.getId(), fullName: 'New Admin Name' }, admin.getId());
        expect(renamed.getFullName()).toBe('New Admin Name');
    });

    it('a rejected update changes nothing', async () => {
        await expect(useCase.execute({ id: employee.getId(), email: 'not-an-email', fullName: 'Should Not Stick' }, admin.getId())).rejects.toBeInstanceOf(ValidationError);
        expect((await repo.findById(employee.getId()))?.getFullName()).toBe('Sara Employee');
    });

    it('404 for an unknown user', async () => {
        await expect(useCase.execute({ id: 'nobody', fullName: 'x' }, admin.getId())).rejects.toBeInstanceOf(NotFoundError);
    });
});
