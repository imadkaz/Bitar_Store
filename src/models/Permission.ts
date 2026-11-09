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
    'returns.refund',   // pay a refund of an approved return
    'cash.open',        // open a cash session
    'cash.accept',      // take over the drawer in a counted handover
    'cash.close',       // count and close the session
    'cash.move',        // cash in or out outside the sales
] as const;

export type Permission = (typeof PERMISSIONS)[number];
export type OverrideEffect = 'allow' | 'deny';

export interface PermissionOverride {
    permission: Permission;
    effect: OverrideEffect;
}

export const ROLE_PERMISSIONS: Record<UserRole, readonly Permission[]> = {
    // confirming an arrival is a manager's act (BL-03): an employee receives only when it is GRANTED (the employees that existed keep it: migration 016)
    [UserRole.EMPLOYEE]: ['sales.create'],
    [UserRole.MANAGER]: [
        'sales.create', 'transfers.receive', 'discounts.apply', 'catalog.create',
        'transfers.dispatch', 'returns.create', 'adjustments.create', 'reports.financial',
        'cash.open', 'cash.accept', 'cash.close', 'cash.move', 'returns.refund',
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
