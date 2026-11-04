import { AuthContext } from '../../models/AuthContext';
import { normalizeCategoryName } from '../../models/Category.model';
import { Permission, PERMISSIONS, ROLE_PERMISSIONS } from '../../models/Permission';
import { computeOverrides, describeAccess, GRANTABLE_PERMISSIONS, PERMISSION_INFO, PermissionLine } from '../../models/PermissionCatalog';
import { UserRole } from '../../models/User.model';
import { IBranchRepository } from '../../repositories/interfaces/IBranchRepository';
import { ILocationRepository } from '../../repositories/interfaces/ILocationRepository';
import { CategoryView, ManagementRepository } from '../../repositories/ManagementRepository';
import { ConflictError } from '../../utils/exeptions/ConflictError';
import { ForbiddenError } from '../../utils/exeptions/ForbiddenError';
import { NotFoundError } from '../../utils/exeptions/NotFoundError';
import { ValidationError } from '../../utils/exeptions/ValidationError';
import { isUuid } from '../../utils/uuid';

const idOf = (raw: string, what: string): string => {
    if (!isUuid(raw)) throw new NotFoundError(`${what} not found`);
    return raw;
};
const requireCatalog = (auth: AuthContext) => {
    if (!auth.can('catalog.create')) throw new ForbiddenError('Missing permission: catalog.create');
};
const requireAdmin = (auth: AuthContext) => {
    if (auth.user.getRole() !== UserRole.ADMIN) throw new ForbiddenError('Only an admin can do this');
};

// ---- categories: the owner adds, renames, deactivates and deletes them
export class ListCategoriesUsecase {
    constructor(private readonly repo: ManagementRepository) {}
    execute(input: { activeOnly?: boolean }): Promise<CategoryView[]> { return this.repo.listCategories(input.activeOnly ?? false); }
}

export class CreateCategoryUsecase {
    constructor(private readonly repo: ManagementRepository) {}
    execute(body: unknown, auth: AuthContext): Promise<CategoryView> {
        requireCatalog(auth);
        if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new ValidationError('The request body is required');
        return this.repo.createCategory(normalizeCategoryName((body as { name?: unknown }).name), auth.user.getId());
    }
}

export class UpdateCategoryUsecase {
    constructor(private readonly repo: ManagementRepository) {}
    execute(rawId: string, body: unknown, auth: AuthContext): Promise<CategoryView> {
        requireCatalog(auth);
        const id = idOf(rawId, 'Category');
        if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new ValidationError('The request body is required');
        const input = body as Record<string, unknown>;
        const unknown = Object.keys(input).filter((k) => !['name', 'isActive'].includes(k));
        if (unknown.length > 0) throw new ValidationError('You can change only: name, isActive');
        if (input.name === undefined && input.isActive === undefined) throw new ValidationError('Nothing to change');
        if (input.isActive !== undefined && typeof input.isActive !== 'boolean') throw new ValidationError('isActive must be true or false');
        return this.repo.updateCategory(id, { name: input.name === undefined ? undefined : normalizeCategoryName(input.name), isActive: input.isActive as boolean | undefined }, auth.user.getId());
    }
}

export class DeleteCategoryUsecase {
    constructor(private readonly repo: ManagementRepository) {}
    execute(rawId: string, auth: AuthContext): Promise<void> {
        requireCatalog(auth);
        return this.repo.deleteCategory(idOf(rawId, 'Category'), auth.user.getId());
    }
}

// ---- products: deleted only when nothing in the history points at them, otherwise archived
export class DeleteStyleUsecase {
    constructor(private readonly repo: ManagementRepository) {}
    execute(rawId: string, auth: AuthContext): Promise<void> {
        requireCatalog(auth);
        return this.repo.deleteStyle(idOf(rawId, 'Style'), auth.user.getId());
    }
}

export class DeleteSkuUsecase {
    constructor(private readonly repo: ManagementRepository) {}
    execute(rawId: string, auth: AuthContext): Promise<void> {
        requireCatalog(auth);
        return this.repo.deleteSku(idOf(rawId, 'Sku'), auth.user.getId());
    }
}

export class DeleteBranchUsecase {
    constructor(private readonly repo: ManagementRepository) {}
    execute(rawId: string, auth: AuthContext): Promise<void> {
        requireAdmin(auth);
        return this.repo.deleteBranch(idOf(rawId, 'Branch'), auth.user.getId());
    }
}

// the user disappears from the lists and cannot log in, but their sales, movements and transfers keep their name
export class SoftDeleteUserUsecase {
    constructor(private readonly repo: ManagementRepository) {}
    execute(rawId: string, auth: AuthContext): Promise<void> {
        requireAdmin(auth);
        const id = idOf(rawId, 'User');
        if (id === auth.user.getId()) throw new ConflictError('You cannot delete your own account');
        return this.repo.softDeleteUser(id, auth.user.getId());
    }
}

// Anyone who is logged in may know WHICH place is the warehouse (to ask it to restock their branch), never its stock.
export class GetWarehouseUsecase {
    constructor(private readonly locations: ILocationRepository) {}
    async execute(): Promise<{ id: string; code: string; name: string }> {
        const warehouse = await this.locations.findWarehouse();
        if (!warehouse || !warehouse.isActive()) throw new NotFoundError('There is no warehouse yet');
        return { id: warehouse.getId(), code: warehouse.getCode(), name: warehouse.getName() };
    }
}

// ---- permissions: the admin gives one user a specific permission (say, an employee who may create products), or takes one away.
// The role stays the base; each change is an override on top of it. It takes effect on the user's very next request.
export class GetPermissionCatalogUsecase {
    // the admin sees all; a manager sees what THEY can hand on (never what they do not have themselves)
    execute(auth: AuthContext) {
        if (auth.user.getRole() !== UserRole.ADMIN && auth.user.getRole() !== UserRole.MANAGER) throw new ForbiddenError('Only an admin or a manager can do this');
        const admin = auth.user.getRole() === UserRole.ADMIN;
        return {
            permissions: PERMISSIONS.map((key) => ({ key, ...PERMISSION_INFO[key], grantable: GRANTABLE_PERMISSIONS.includes(key) && (admin || auth.can(key)) })),
            roles: Object.fromEntries(Object.values(UserRole).map((role) => [role, [...ROLE_PERMISSIONS[role]] as Permission[]])) as Record<string, Permission[]>,
        };
    }
}

export interface UserPermissions {
    user: { id: string; fullName: string; role: string; isActive: boolean };
    permissions: PermissionLine[];
    overrides: { permission: string; effect: string }[];
}

type Target = NonNullable<Awaited<ReturnType<ManagementRepository['findPermissionTarget']>>>;

// The admin gives permissions to managers and employees. A manager gives them to the EMPLOYEES of their own branches,
// and only permissions the manager has too. Nobody changes their own, and an admin has everything already.
function requireMayManage(auth: AuthContext, target: Target): void {
    const role = auth.user.getRole();
    if (role === UserRole.ADMIN) {
        if (target.role === UserRole.ADMIN) throw new ConflictError('An admin already has every permission: change the role instead');
        return;
    }
    if (role !== UserRole.MANAGER) throw new ForbiddenError('Only an admin or a manager can do this');
    if (target.role !== UserRole.EMPLOYEE) throw new ForbiddenError('A manager can manage the permissions of employees only');
    const mine = new Set(auth.getBranchIds());
    if (!target.branchIds.some((id) => mine.has(id))) throw new NotFoundError('User not found');       // an employee of other branches does not exist for you
}

function present(target: Target): UserPermissions {
    return {
        user: { id: target.id, fullName: target.fullName, role: target.role, isActive: target.isActive },
        permissions: describeAccess(target.role as UserRole, target.overrides as { permission: Permission; effect: 'allow' | 'deny' }[]),
        overrides: target.overrides,
    };
}

export class GetUserPermissionsUsecase {
    constructor(private readonly repo: ManagementRepository) {}

    async execute(rawId: string, auth: AuthContext): Promise<UserPermissions> {
        const id = idOf(rawId, 'User');
        if (auth.user.getRole() !== UserRole.ADMIN && auth.user.getRole() !== UserRole.MANAGER) throw new ForbiddenError('Only an admin or a manager can do this');
        const target = await this.repo.findPermissionTarget(id);
        if (!target) throw new NotFoundError('User not found');
        if (auth.user.getRole() === UserRole.MANAGER) requireMayManage(auth, target);          // an admin may look at an admin too
        return present(target);
    }
}

export class SetUserPermissionsUsecase {
    constructor(private readonly repo: ManagementRepository) {}

    async execute(rawId: string, body: unknown, auth: AuthContext): Promise<UserPermissions> {
        if (auth.user.getRole() !== UserRole.ADMIN && auth.user.getRole() !== UserRole.MANAGER) throw new ForbiddenError('Only an admin or a manager can do this');
        const id = idOf(rawId, 'User');
        if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new ValidationError('The request body is required');
        if (id === auth.user.getId()) throw new ConflictError('You cannot change your own permissions');
        const target = await this.repo.findPermissionTarget(id);
        if (!target) throw new NotFoundError('User not found');
        requireMayManage(auth, target);

        const current = target.overrides as { permission: Permission; effect: 'allow' | 'deny' }[];
        const wanted = (body as { permissions?: unknown }).permissions;
        const next = computeOverrides(target.role as UserRole, current, wanted);
        if (auth.user.getRole() === UserRole.MANAGER) {
            for (const [key, value] of Object.entries(wanted as Record<string, unknown>)) {
                if (value === true && !auth.can(key as Permission)) throw new ForbiddenError(`You cannot give a permission you do not have: ${key}`);
            }
        }
        const sameAsBefore = JSON.stringify([...current].sort((a, b) => a.permission.localeCompare(b.permission))) === JSON.stringify(next);
        if (!sameAsBefore) {
            const allowed = (overrides: typeof current) => describeAccess(target.role as UserRole, overrides).filter((l) => l.allowed).map((l) => l.key);
            await this.repo.replacePermissionOverrides(id, next, auth.user.getId(), { before: allowed(current), after: allowed(next), user: target.fullName });
        }
        return present((await this.repo.findPermissionTarget(id))!);
    }
}

// ---- which branches a user reaches: a list of branches, or EVERY branch (a manager appointed to all of them)
export interface BranchAccess { userId: string; mode: 'all' | 'selected'; branchIds: string[] }

export class GetBranchAccessUsecase {
    constructor(private readonly repo: ManagementRepository) {}

    async execute(rawId: string, auth: AuthContext): Promise<BranchAccess> {
        requireAdmin(auth);
        const target = await this.repo.findPermissionTarget(idOf(rawId, 'User'));
        if (!target) throw new NotFoundError('User not found');
        return { userId: target.id, mode: target.allBranches ? 'all' : 'selected', branchIds: target.branchIds };
    }
}

export class SetBranchAccessUsecase {
    constructor(private readonly repo: ManagementRepository) {}

    // { "mode": "all" } or { "mode": "selected" } (then the branches are the ones granted one by one with PUT /users/:id/branches/:branchId)
    async execute(rawId: string, body: unknown, auth: AuthContext): Promise<BranchAccess> {
        requireAdmin(auth);
        const id = idOf(rawId, 'User');
        const mode = typeof body === 'object' && body !== null ? (body as { mode?: unknown }).mode : undefined;
        if (mode !== 'all' && mode !== 'selected') throw new ValidationError('mode must be "all" or "selected"');
        const target = await this.repo.findPermissionTarget(id);
        if (!target) throw new NotFoundError('User not found');
        if (target.role === UserRole.ADMIN) throw new ConflictError('An admin already reaches every place');
        if (mode === 'all' && target.role !== UserRole.MANAGER) throw new ConflictError('Only a manager can be appointed to all branches');
        await this.repo.setAllBranches(id, mode === 'all', auth.user.getId());
        const after = (await this.repo.findPermissionTarget(id))!;
        return { userId: id, mode: after.allBranches ? 'all' : 'selected', branchIds: after.branchIds };
    }
}
export class ListPlacesUsecase {
    constructor(private readonly branches: IBranchRepository) {}

    async execute(auth: AuthContext): Promise<{ id: string; code: string; name: string; kind: string }[]> {
        if (!auth.can('transfers.dispatch') && !auth.can('transfers.receive')) throw new ForbiddenError('Missing permission: transfers.dispatch');
        return (await this.branches.list())
            .filter((b) => b.isActive())
            .map((b) => ({ id: b.getId(), code: b.getCode(), name: b.getName(), kind: b.getKind() as string }))
            .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'warehouse' ? -1 : 1));      // the warehouse first
    }
}