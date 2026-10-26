// src/models/User.model.ts
import { ValidationError } from "../utils/exeptions/ValidationError";

export enum UserRole {
    ADMIN = 'admin',
    MANAGER = 'manager',
    EMPLOYEE = 'employee',
}

export function normalizeEmail(email: unknown): string {
    if (typeof email !== 'string' || email.trim().length === 0) {
        throw new ValidationError('Email is required');
    }
    const normalizedEmail = email.trim().toLowerCase();
    if (normalizedEmail.length < 4 || normalizedEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
        throw new ValidationError('Email is invalid');
    }
    return normalizedEmail;
}

function validateFullName(fullName: unknown): string {
    if (typeof fullName !== 'string' || fullName.trim().length === 0) {
        throw new ValidationError('Full name is required');
    }
    const trimmedFullName = fullName.trim();
    if (trimmedFullName.length < 2 || trimmedFullName.length > 100) {
        throw new ValidationError('Full name must be between 2 and 100 characters');
    }
    return trimmedFullName;
}

// The database column is nullable (NULL = no password yet), so the entity accepts null.
// A real hash only has to be non-empty (same as the database CHECK).
function validatePasswordHash(passwordHash: unknown): string | null {
    if (passwordHash === null || passwordHash === undefined) return null;
    if (typeof passwordHash !== 'string' || passwordHash.length === 0) {
        throw new ValidationError('Password hash is invalid');
    }
    return passwordHash;
}

// Rules for the PLAIN password, checked before hashing. bcrypt only reads the first 72 bytes.
export function assertValidPassword(password: unknown): asserts password is string {
    if (typeof password !== 'string') throw new ValidationError('Password is required');
    if (password.length < 8) throw new ValidationError('Password must be at least 8 characters');
    if (Buffer.byteLength(password, 'utf8') > 72) throw new ValidationError('Password must be at most 72 bytes');
}

function validateRole(role: unknown): UserRole {
    if (!Object.values(UserRole).includes(role as UserRole)) {
        throw new ValidationError('Role must be one of: admin, manager, employee');
    }
    return role as UserRole;
}

export interface UserProps {
    id: string;
    email: string;
    passwordHash?: string | null;
    fullName: string;
    role: UserRole;
    isActive?: boolean;
    deactivatedAt?: Date | null;
    createdAt?: Date;
    updatedAt?: Date;
}

export class User {
    private constructor(
        private readonly id: string,
        private email: string,                 // not readonly anymore: changeEmail()
        private passwordHash: string | null,
        private fullName: string,
        private role: UserRole,
        private active: boolean,
        private deactivatedAt: Date | null,
        private readonly createdAt: Date,
        private updatedAt: Date,
    ) {}

    static create(props: UserProps): User {
        const now = new Date();
        const active = props.isActive ?? true;
        // database CHECK users_deactivation_ok: an inactive user must have a deactivation date
        const deactivatedAt = active ? (props.deactivatedAt ?? null) : (props.deactivatedAt ?? now);
        return new User(
            props.id,
            normalizeEmail(props.email),
            validatePasswordHash(props.passwordHash),
            validateFullName(props.fullName),
            validateRole(props.role),
            active,
            deactivatedAt,
            props.createdAt ?? now,
            props.updatedAt ?? now,
        );
    }

    rename(fullName: string): void { this.fullName = validateFullName(fullName); }
    changeEmail(email: string): void { this.email = normalizeEmail(email); }
    changeRole(role: UserRole): void { this.role = validateRole(role); }

    changePasswordHash(passwordHash: string): void {
        const validated = validatePasswordHash(passwordHash);
        if (validated === null) throw new ValidationError('Password hash is required');
        this.passwordHash = validated;
    }

    deactivate(at: Date = new Date()): void {
        this.active = false;
        this.deactivatedAt = at;
    }

    activate(): void {
        this.active = true;
        this.deactivatedAt = null;
    }

    getId(): string { return this.id; }
    getEmail(): string { return this.email; }
    getPasswordHash(): string | null { return this.passwordHash; }
    getFullName(): string { return this.fullName; }
    getRole(): UserRole { return this.role; }
    isActive(): boolean { return this.active; }
    hasPassword(): boolean { return this.passwordHash !== null; }
    getDeactivatedAt(): Date | null { return this.deactivatedAt; }
    getCreatedAt(): Date { return this.createdAt; }
    getUpdatedAt(): Date { return this.updatedAt; }
}