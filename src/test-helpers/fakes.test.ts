import { describe, expect, it } from 'vitest';
import { FakeUserRepository, makeUser } from './fakes';

// Tests for the helper itself: if the fake lies, every test built on it lies.
describe('FakeUserRepository behaves like the real database', () => {
    it('changing a loaded user does NOT change the stored one until update() is called', async () => {
        const stored = makeUser({ fullName: 'Original Name' });
        const repo = new FakeUserRepository([stored]);

        const loaded = (await repo.findById(stored.getId()))!;
        loaded.rename('Changed In Memory');

        expect((await repo.findById(stored.getId()))?.getFullName()).toBe('Original Name');
        await repo.update(loaded, null);
        expect((await repo.findById(stored.getId()))?.getFullName()).toBe('Changed In Memory');
    });

    it('refuses a duplicate email, like the unique index', async () => {
        const a = makeUser();
        const repo = new FakeUserRepository([a]);
        const clone = makeUser({ email: a.getEmail() });
        await expect(repo.create(clone, null)).rejects.toThrow('already exists');
    });

    it('records who created and who last changed a user', async () => {
        const repo = new FakeUserRepository();
        const user = makeUser();
        await repo.create(user, 'admin-1');
        const loaded = (await repo.findById(user.getId()))!;
        loaded.rename('Someone Else');
        await repo.update(loaded, 'admin-2');
        expect(repo.audit.get(user.getId())).toEqual({ createdBy: 'admin-1', updatedBy: 'admin-2' });
    });
});
