import { describe, expect, it } from 'vitest';
import { User, UserRole, normalizeEmail } from '../User.model';

const base = { id: 'u1', email: 'Ali@Bitar.com ', fullName: ' Ali Bitar ', passwordHash: 'test-hash', role: UserRole.EMPLOYEE };

describe('User', () => {
    it('normalizes email and trims the name', () => {
        const user = User.create(base);
        expect(user.getEmail()).toBe('ali@bitar.com');
        expect(user.getFullName()).toBe('Ali Bitar');
        expect(user.isActive()).toBe(true);
        expect(user.getDeactivatedAt()).toBeNull();
    });

    it('rejects an invalid email', () => {
        expect(() => normalizeEmail('not-an-email')).toThrow('Email is invalid');
        expect(() => normalizeEmail(42 as unknown as string)).toThrow('Email is required');
    });

    it('rejects an invalid role and a blank name', () => {
        expect(() => User.create({ ...base, role: 'boss' as never })).toThrow('Role must be one of');
        expect(() => User.create({ ...base, fullName: '   ' })).toThrow('Full name is required');
    });

    it('deactivate sets a date, activate clears it (matches the database CHECK)', () => {
        const user = User.create(base);
        user.deactivate();
        expect(user.isActive()).toBe(false);
        expect(user.getDeactivatedAt()).toBeInstanceOf(Date);
        user.activate();
        expect(user.isActive()).toBe(true);
        expect(user.getDeactivatedAt()).toBeNull();
    });

    it('an inactive user is never created without a deactivation date', () => {
        const user = User.create({ ...base, isActive: false });
        expect(user.getDeactivatedAt()).toBeInstanceOf(Date);
    });
});
