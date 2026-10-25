import { Permission, canViewCosts } from './Permission';
import { User, UserRole } from './User.model';

// Who is making this request and what may they do. Built fresh on every request.
export class AuthContext {
    constructor(
        readonly user: User,
        private readonly permissions: ReadonlySet<Permission>,
        private readonly branchIds: ReadonlySet<string>,
    ) {}

    isAdmin(): boolean { return this.user.getRole() === UserRole.ADMIN; }
    can(permission: Permission): boolean { return this.permissions.has(permission); }
    // admins reach every branch; everyone else only the branches granted to them
    canAccessBranch(branchId: string): boolean { return this.isAdmin() || this.branchIds.has(branchId); }
    canViewCosts(): boolean { return canViewCosts(this.user.getRole()); }
    getPermissions(): Permission[] { return [...this.permissions].sort(); }
    getBranchIds(): string[] { return [...this.branchIds]; }
}
