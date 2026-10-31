import { randomUUID } from 'node:crypto';
import { Branch, BranchProps } from '../models/Branch.model';
import { User, UserProps, UserRole } from '../models/User.model';
import { IBranchRepository } from '../repositories/interfaces/IBranchRepository';
import { IUserRepository } from '../repositories/interfaces/IUserRepository';
import { ConflictError } from '../utils/exeptions/ConflictError';

// ---------------------------------------------------------------------------------------------
// A "fake" repository is a pretend database that lives in memory. Use-case tests use it instead of
// Neon: no network, no cleanup, and every test starts from a clean state.
// ---------------------------------------------------------------------------------------------

// The real database never hands out the same object twice: every read builds a NEW entity from the row.
// The fakes copy on write and on read to behave the same way. Without this, a use case that forgets to call
// update() would still look correct in tests, because it would be changing the stored object directly.
function copyUser(user: User): User {
    return User.create({
        id: user.getId(),
        email: user.getEmail(),
        passwordHash: user.getPasswordHash(),
        fullName: user.getFullName(),
        role: user.getRole(),
        isActive: user.isActive(),
        deactivatedAt: user.getDeactivatedAt(),
        createdAt: user.getCreatedAt(),
        updatedAt: user.getUpdatedAt(),
    });
}

function copyBranch(branch: Branch): Branch {
    return Branch.create({
        id: branch.getId(),
        code: branch.getCode(),
        name: branch.getName(),
        isActive: branch.isActive(),
        kind: branch.getKind(),
        createdAt: branch.getCreatedAt(),
        updatedAt: branch.getUpdatedAt(),
    });
}

export class FakeUserRepository implements IUserRepository {
    private readonly items = new Map<string, User>();
    // who created / last changed each user (the real tables have created_by / updated_by)
    readonly audit = new Map<string, { createdBy: string | null; updatedBy: string | null }>();

    constructor(seed: User[] = []) {
        seed.forEach((user) => this.items.set(user.getId(), copyUser(user)));
    }

    async findById(id: string) {
        const found = this.items.get(id);
        return found ? copyUser(found) : null;
    }
    async delete(id: string) { this.items.delete(id); }
    async findByEmail(email: string) {
        const found = [...this.items.values()].find((u) => u.getEmail() === email);
        return found ? copyUser(found) : null;
    }

    async list() {
        return [...this.items.values()].map(copyUser);
    }

    async create(user: User, actorId: string | null) {
        this.assertEmailIsFree(user);
        this.items.set(user.getId(), copyUser(user));
        this.audit.set(user.getId(), { createdBy: actorId, updatedBy: actorId });
        return copyUser(user);
    }

    async update(user: User, actorId: string | null) {
        this.assertEmailIsFree(user);
        this.items.set(user.getId(), copyUser(user));
        this.audit.set(user.getId(), { createdBy: this.audit.get(user.getId())?.createdBy ?? null, updatedBy: actorId });
        return copyUser(user);
    }

    // the real database has a unique index on email; the fake must refuse duplicates too
    private assertEmailIsFree(user: User) {
        const other = [...this.items.values()].find((u) => u.getEmail() === user.getEmail() && u.getId() !== user.getId());
        if (other) throw new ConflictError('A user with this email already exists');
    }
}

export class FakeBranchRepository implements IBranchRepository {
    private readonly items = new Map<string, Branch>();

    constructor(seed: Branch[] = []) {
        seed.forEach((branch) => this.items.set(branch.getId(), copyBranch(branch)));
    }

    async findById(id: string) {
        const found = this.items.get(id);
        return found ? copyBranch(found) : null;
    }

    async findByCode(code: string) {
        const found = [...this.items.values()].find((b) => b.getCode() === code);
        return found ? copyBranch(found) : null;
    }

    async findByIds(ids: string[]) {
        return ids.map((id) => this.items.get(id)).filter((b): b is Branch => !!b).map(copyBranch);
    }

    async list() {
        return [...this.items.values()].map(copyBranch);
    }

    async save(branch: Branch) {
        if (await this.findByCode(branch.getCode())) throw new ConflictError('A branch with this code already exists');
        this.items.set(branch.getId(), copyBranch(branch));
        return copyBranch(branch);
    }

    async update(branch: Branch) {
        this.items.set(branch.getId(), copyBranch(branch));
        return copyBranch(branch);
    }
}

// ---------------------------------------------------------------------------------------------
// Builders: a valid entity in one line. Each call gets unique values, so tests only spell out
// what they care about, e.g. makeUser({ role: UserRole.ADMIN }).
// ---------------------------------------------------------------------------------------------
let counter = 0;

export function makeUser(overrides: Partial<UserProps> = {}): User {
    const n = ++counter;
    return User.create({
        id: randomUUID(),
        email: `user${n}@bitar.test`,
        passwordHash: 'fake-hash-not-a-real-bcrypt-hash',   // no bcrypt here: it would only slow the tests down
        fullName: `Test User ${n}`,
        role: UserRole.EMPLOYEE,
        ...overrides,
    });
}

export function makeBranch(overrides: Partial<BranchProps> = {}): Branch {
    const n = ++counter;
    return Branch.create({ id: randomUUID(), code: `BR${n}`, name: `Test Branch ${n}`, ...overrides });
}
