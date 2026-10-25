import { ValidationError } from '../utils/exeptions/ValidationError';

// Database CHECK (branches_code_format): upper-case, trimmed, 1..20 chars.
export function normalizeBranchCode(code: string): string {
    if (typeof code !== 'string') throw new ValidationError('Branch code is required');
    const normalized = code.trim().toUpperCase();
    if (normalized.length < 1 || normalized.length > 20) {
        throw new ValidationError('Branch code must be between 1 and 20 characters');
    }
    if (!/^[A-Z0-9_-]+$/.test(normalized)) {
        throw new ValidationError('Branch code may only contain letters, digits, "-" and "_"');
    }
    return normalized;
}

function validateName(name: string): string {
    if (typeof name !== 'string') throw new ValidationError('Branch name is required');
    const trimmed = name.trim();
    if (trimmed.length === 0) throw new ValidationError('Branch name is required');
    if (trimmed.length > 120) throw new ValidationError('Branch name must be at most 120 characters');
    return trimmed;
}

export interface BranchProps {
    id: string;
    code: string;
    name: string;
    isActive?: boolean;
    createdAt?: Date;
    updatedAt?: Date;
}

export class Branch {
    private constructor(
        private readonly id: string,
        private readonly code: string,
        private name: string,
        private active: boolean,
        private readonly createdAt: Date,
        private updatedAt: Date,
    ) {}

    static create(props: BranchProps): Branch {
        const now = new Date();
        return new Branch(
            props.id,
            normalizeBranchCode(props.code),
            validateName(props.name),
            props.isActive ?? true,
            props.createdAt ?? now,
            props.updatedAt ?? now,
        );
    }

    rename(name: string): void { this.name = validateName(name); }
    deactivate(): void { this.active = false; }   // branches are deactivated, never deleted
    activate(): void { this.active = true; }

    getId(): string { return this.id; }
    getCode(): string { return this.code; }
    getName(): string { return this.name; }
    isActive(): boolean { return this.active; }
    getCreatedAt(): Date { return this.createdAt; }
    getUpdatedAt(): Date { return this.updatedAt; }
}
