import { describe, expect, it } from 'vitest';
import { canViewCosts, resolvePermissions } from '../Permission';
import { UserRole } from '../User.model';

describe('permissions', () => {
    it('employee gets only the basic permissions', () => {
        const p = resolvePermissions(UserRole.EMPLOYEE, []);
        expect(p.has('sales.create')).toBe(true);
        expect(p.has('discounts.apply')).toBe(false);
        expect(p.has('users.administer')).toBe(false);
    });

    it('admin has every permission', () => {
        expect(resolvePermissions(UserRole.ADMIN, []).has('users.administer')).toBe(true);
    });

    it('an allow override adds a permission', () => {
        const p = resolvePermissions(UserRole.EMPLOYEE, [{ permission: 'discounts.apply', effect: 'allow' }]);
        expect(p.has('discounts.apply')).toBe(true);
    });

    it('a deny override removes a role default', () => {
        const p = resolvePermissions(UserRole.MANAGER, [{ permission: 'adjustments.create', effect: 'deny' }]);
        expect(p.has('adjustments.create')).toBe(false);
        expect(p.has('sales.create')).toBe(true);
    });

    it('cost visibility depends on the role only', () => {
        expect(canViewCosts(UserRole.EMPLOYEE)).toBe(false);
        expect(canViewCosts(UserRole.MANAGER)).toBe(true);
        expect(canViewCosts(UserRole.ADMIN)).toBe(true);
    });
});
