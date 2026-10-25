import { UserRole } from './User.model';

// Same list as the database CHECK (upo_permission_valid).
// 'costs.view' is deliberately NOT here: cost visibility depends on the ROLE only.
export const PERMISSIONS = [
    'sales.create',
    'discounts.apply',
    'catalog.create',
    'transfers.dispatch',
    'transfers.receive',
    'returns.create',
    'adjustments.create',
    'reports.financial',
    'users.administer',
] as const;

export type Permission = (typeof PERMISSIONS)[number];
export type OverrideEffect = 'allow' | 'deny';

export interface PermissionOverride {
    permission: Permission;
    effect: OverrideEffect;
}

export const ROLE_PERMISSIONS: Record<UserRole, readonly Permission[]> = {
    [UserRole.EMPLOYEE]: ['sales.create', 'transfers.receive'],
    [UserRole.MANAGER]: [
        'sales.create', 'transfers.receive', 'discounts.apply', 'catalog.create',
        'transfers.dispatch', 'returns.create', 'adjustments.create', 'reports.financial',
    ],
    [UserRole.ADMIN]: [...PERMISSIONS],
};

export function canViewCosts(role: UserRole): boolean {
    return role === UserRole.ADMIN || role === UserRole.MANAGER;
}

// Role defaults first, then the individual overrides on top (allow adds, deny removes).
export function resolvePermissions(role: UserRole, overrides: readonly PermissionOverride[]): Set<Permission> {
    const result = new Set<Permission>(ROLE_PERMISSIONS[role]);
    for (const override of overrides) {
        if (override.effect === 'allow') result.add(override.permission);
        else result.delete(override.permission);
    }
    return result;
}
