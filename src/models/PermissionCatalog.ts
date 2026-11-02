import { OverrideEffect, Permission, PERMISSIONS, PermissionOverride, ROLE_PERMISSIONS, resolvePermissions } from './Permission';
import { UserRole } from './User.model';
import { ValidationError } from '../utils/exeptions/ValidationError';

// What each permission means, in words the screens can show next to a checkbox.
export const PERMISSION_INFO: Record<Permission, { label: string; description: string }> = {
    'sales.create': { label: 'Sell at the till', description: 'Make sales at the branches they reach.' },
    'discounts.apply': { label: 'Give discounts', description: 'Percent discounts and price overrides on a sale, with a reason.' },
    'catalog.create': { label: 'Manage products', description: 'Create, edit, price, archive and delete products, skus, barcodes and categories.' },
    'transfers.dispatch': { label: 'Send transfers', description: 'Prepare, send and cancel transfers, and confirm that missing pieces are lost.' },
    'transfers.receive': { label: 'Receive transfers', description: 'Receive what arrives at their branch, and ask the warehouse to restock it.' },
    'returns.create': { label: 'Record returns', description: 'Customer returns (not built yet).' },
    'adjustments.create': { label: 'Manage stock', description: 'Opening stock, stock adjustments, minimum levels, "what to send" suggestions and the movement history.' },
    'reports.financial': { label: 'See sales reports', description: 'Sales per branch and per day, best sellers.' },
    'users.administer': { label: 'Manage users', description: 'Create users and change their roles and permissions. Only admins have it: it cannot be granted.' },
};

// An admin keeps this one for the admin role alone: granting it to a manager or an employee would let them hand out more power.
export const NOT_GRANTABLE: readonly Permission[] = ['users.administer'];
export const GRANTABLE_PERMISSIONS: readonly Permission[] = PERMISSIONS.filter((p) => !NOT_GRANTABLE.includes(p));

export type PermissionSource = 'role' | 'granted' | 'denied' | 'none';

export interface PermissionLine {
    key: Permission;
    label: string;
    description: string;
    allowed: boolean;
    source: PermissionSource;      // role: comes with the role · granted: added for this person · denied: taken away from this person · none: not allowed
}

// The permissions of one person, one line for each, with WHY it is allowed or not.
export function describeAccess(role: UserRole, overrides: readonly PermissionOverride[]): PermissionLine[] {
    const resolved = resolvePermissions(role, overrides);
    const byKey = new Map<Permission, OverrideEffect>(overrides.map((o) => [o.permission, o.effect]));
    return PERMISSIONS.map((key) => {
        const allowed = resolved.has(key);
        const byRole = ROLE_PERMISSIONS[role].includes(key);
        const effect = byKey.get(key);
        const source: PermissionSource = allowed ? (byRole ? 'role' : 'granted') : byRole && effect === 'deny' ? 'denied' : 'none';
        return { key, ...PERMISSION_INFO[key], allowed, source };
    });
}

// The screen sends the state it wants ({ "catalog.create": true }); this turns it into the smallest set of overrides on top of the role.
// A permission the role already gives (or already lacks) needs no override at all.
export function computeOverrides(role: UserRole, current: readonly PermissionOverride[], wanted: unknown): PermissionOverride[] {
    if (typeof wanted !== 'object' || wanted === null || Array.isArray(wanted) || Object.keys(wanted).length === 0) {
        throw new ValidationError('permissions must be an object like { "catalog.create": true }');
    }
    const next = new Map<Permission, OverrideEffect>(current.map((o) => [o.permission, o.effect]));
    for (const [key, value] of Object.entries(wanted as Record<string, unknown>)) {
        if (!(PERMISSIONS as readonly string[]).includes(key)) throw new ValidationError(`Unknown permission: ${key}`);
        if (NOT_GRANTABLE.includes(key as Permission)) throw new ValidationError(`${key} cannot be granted or taken away: it belongs to the admin role`);
        if (typeof value !== 'boolean') throw new ValidationError(`${key} must be true or false`);
        const permission = key as Permission;
        const byRole = ROLE_PERMISSIONS[role].includes(permission);
        if (value === byRole) next.delete(permission);
        else next.set(permission, value ? 'allow' : 'deny');
    }
    return [...next].map(([permission, effect]) => ({ permission, effect })).sort((a, b) => a.permission.localeCompare(b.permission));
}
