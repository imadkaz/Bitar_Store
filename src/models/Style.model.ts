import { ValidationError } from '../utils/exeptions/ValidationError';

// The style code is stored UPPER CASE so "nk-100" and "NK-100" can never become two styles.
export function normalizeStyleCode(code: string): string {
    if (typeof code !== 'string') throw new ValidationError('Style code is required');
    const normalized = code.trim().toUpperCase();
    if (normalized.length === 0) throw new ValidationError('Style code is required');
    if (normalized.length > 40) throw new ValidationError('Style code must be at most 40 characters');
    if (!/^[A-Z0-9][A-Z0-9._/-]*$/.test(normalized)) {
        throw new ValidationError('Style code may only contain letters, digits and . _ / -');
    }
    return normalized;
}

export function validateStyleName(name: string): string {
    if (typeof name !== 'string') throw new ValidationError('Style name is required');
    const trimmed = name.trim();
    if (trimmed.length === 0) throw new ValidationError('Style name is required');
    if (trimmed.length > 120) throw new ValidationError('Style name must be at most 120 characters');
    return trimmed;
}

// Optional: nothing or an empty text means "no category" (null).
export function validateCategory(category: string | null | undefined): string | null {
    if (category === undefined || category === null) return null;
    if (typeof category !== 'string') throw new ValidationError('Category must be text');
    const trimmed = category.trim();
    if (trimmed.length === 0) return null;
    if (trimmed.length > 60) throw new ValidationError('Category must be at most 60 characters');
    return trimmed;
}

export interface StyleProps {
    id: string;
    code: string;
    name: string;
    category?: string | null;
    isActive?: boolean;
    createdAt?: Date;
    updatedAt?: Date;
}

// A style is the MODEL of a garment ("Nike Club tee"). What is actually sold and counted is a sku (a size + color of it).
export class Style {
    private constructor(
        private readonly id: string,
        private readonly code: string,
        private name: string,
        private category: string | null,
        private active: boolean,
        private readonly createdAt: Date,
        private updatedAt: Date,
    ) {}

    static create(props: StyleProps): Style {
        const now = new Date();
        return new Style(
            props.id,
            normalizeStyleCode(props.code),
            validateStyleName(props.name),
            validateCategory(props.category),
            props.isActive ?? true,
            props.createdAt ?? now,
            props.updatedAt ?? now,
        );
    }

    rename(name: string): void { this.name = validateStyleName(name); }
    changeCategory(category: string): void { this.category = validateCategory(category); }
    deactivate(): void { this.active = false; }   // styles are deactivated, never deleted
    activate(): void { this.active = true; }

    getId(): string { return this.id; }
    getCode(): string { return this.code; }
    getName(): string { return this.name; }
    getCategory(): string | null { return this.category; }
    isActive(): boolean { return this.active; }
    getCreatedAt(): Date { return this.createdAt; }
    getUpdatedAt(): Date { return this.updatedAt; }
}
