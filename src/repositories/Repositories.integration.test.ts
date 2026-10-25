import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { prisma } from '../db';
import { Branch } from '../models/Branch.model';
import { User, UserRole } from '../models/User.model';
import { BranchRepository } from './BranchRepository';
import { UserAccessRepository } from './UserAccessRepository';
import { UserRepository } from './UserRepository';

const users = new UserRepository(prisma);
const branches = new BranchRepository(prisma);
const access = new UserAccessRepository(prisma);

const userIds: string[] = [];
const branchIds: string[] = [];
const stamp = Date.now();

afterEach(async () => {
    await prisma.userBranchAccess.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.userPermissionOverride.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.branch.deleteMany({ where: { id: { in: branchIds } } });
    userIds.length = 0;
    branchIds.length = 0;
});

async function makeUser(tag: string, role = UserRole.EMPLOYEE) {
    const user = User.create({ id: randomUUID(), email: `${tag}-${stamp}@bitar.test`, fullName: 'Test User', role });
    userIds.push(user.getId());
    await users.create(user, null);
    return user;
}

describe('Prisma repositories (integration, real database)', () => {
    it('creates a user and reads it back', async () => {
        const user = await makeUser('create');
        expect((await users.findByEmail(user.getEmail()))?.getId()).toBe(user.getId());
    });

    it('turns a duplicate email into ConflictError', async () => {
        const first = await makeUser('dup');
        const clone = User.create({ id: randomUUID(), email: first.getEmail(), fullName: 'Clone', role: UserRole.EMPLOYEE });
        await expect(users.create(clone, null)).rejects.toThrow('already exists');
    });

    it('deactivate/activate satisfy the database CHECK and the trigger bumps the version', async () => {
        const user = await makeUser('toggle');
        user.deactivate();
        const off = await users.update(user, user.getId());
        expect(off.isActive()).toBe(false);
        expect(off.getDeactivatedAt()).toBeInstanceOf(Date);

        const row = await prisma.user.findUnique({ where: { id: user.getId() } });
        expect(row?.version).toBe(2);
        expect(row?.updatedBy).toBe(user.getId());

        user.activate();
        expect((await users.update(user, user.getId())).isActive()).toBe(true);
    });

    it('a duplicate branch code is a ConflictError', async () => {
        const branch = Branch.create({ id: randomUUID(), code: `T${stamp}`.slice(0, 20), name: 'Test' });
        branchIds.push(branch.getId());
        await branches.save(branch, null);
        const clone = Branch.create({ id: randomUUID(), code: branch.getCode(), name: 'Clone' });
        await expect(branches.save(clone, null)).rejects.toThrow('already exists');
    });

    it('grant is idempotent, revoke removes, overrides are read back', async () => {
        const user = await makeUser('access');
        const branch = Branch.create({ id: randomUUID(), code: `A${stamp}`.slice(0, 20), name: 'Access' });
        branchIds.push(branch.getId());
        await branches.save(branch, null);

        await access.grantBranch(user.getId(), branch.getId(), null);
        await access.grantBranch(user.getId(), branch.getId(), null);
        expect(await access.findBranchIds(user.getId())).toEqual([branch.getId()]);

        await prisma.userPermissionOverride.create({ data: { userId: user.getId(), permission: 'discounts.apply', effect: 'allow' } });
        expect(await access.findOverrides(user.getId())).toEqual([{ permission: 'discounts.apply', effect: 'allow' }]);

        await access.revokeBranch(user.getId(), branch.getId());
        expect(await access.findBranchIds(user.getId())).toEqual([]);
    });
});
