import { ValidationError } from '../utils/exeptions/ValidationError';
import { assertCents, formatCents } from './Money';

export function normalizeSkuCode(code: string): string {
    if (typeof code !== 'string') throw new ValidationError('Sku code is required');
    const normalized = code.trim().toUpperCase();
    if (normalized.length === 0) throw new ValidationError('Sku code is required');
    if (normalized.length > 40) throw new ValidationError('Sku code must be at most 40 characters');
    if (!/^[A-Z0-9][A-Z0-9._/-]*$/.test(normalized)) {
        throw new ValidationError('Sku code may only contain letters, digits and . _ / -');
    }
    return normalized;
}

export function validateSize(size: string): string {
    if (typeof size !== 'string') throw new ValidationError('Size is required');
    const trimmed = size.trim();
    if (trimmed.length === 0) throw new ValidationError('Size is required');
    if (trimmed.length > 20) throw new ValidationError('Size must be at most 20 characters');
    return trimmed;
}

export function validateColor(color: string): string {
    if (typeof color !== 'string') throw new ValidationError('Color is required');
    const trimmed = color.trim();
    if (trimmed.length === 0) throw new ValidationError('Color is required');
    if (trimmed.length > 40) throw new ValidationError('Color must be at most 40 characters');
    return trimmed;
}

// Nothing means USD (the database default); otherwise 3 letters.
export function normalizeCurrency(currency?: string | null): string {
    if (currency === undefined || currency === null) return 'USD';
    if (typeof currency !== 'string' || !/^[A-Za-z]{3}$/.test(currency.trim())) {
        throw new ValidationError('Currency must be 3 letters, like USD');
    }
    return currency.trim().toUpperCase();
}

export interface SkuProps {
    id: string;
    styleId: string;
    skuCode: string;
    size: string;
    color: string;
    standardPriceCents: number;
    currency?: string;
    isActive?: boolean;
    createdAt?: Date;
    updatedAt?: Date;
}

// A sku is one sellable variant: a style in one size and one color, with its standard price.
// The sku code and the currency never change after creation; the price changes only through changePrice().
export class Sku {
    private constructor(
        private readonly id: string,
        private readonly styleId: string,
        private readonly skuCode: string,
        private size: string,
        private color: string,
        private standardPriceCents: number,
        private readonly currency: string,
        private active: boolean,
        private readonly createdAt: Date,
        private updatedAt: Date,
    ) {}

    static create(props: SkuProps): Sku {
        assertCents(props.standardPriceCents, 'Standard price');
        const now = new Date();
        return new Sku(
            props.id,
            props.styleId,
            normalizeSkuCode(props.skuCode),
            validateSize(props.size),
            validateColor(props.color),
            props.standardPriceCents,
            normalizeCurrency(props.currency),
            props.isActive ?? true,
            props.createdAt ?? now,
            props.updatedAt ?? now,
        );
    }

    changeSize(size: string): void { this.size = validateSize(size); }
    changeColor(color: string): void { this.color = validateColor(color); }

    // returns false when the price is already that value (nothing to record)
    changePrice(cents: number): boolean {
        assertCents(cents, 'Standard price');
        if (cents === this.standardPriceCents) return false;
        this.standardPriceCents = cents;
        return true;
    }

    deactivate(): void { this.active = false; }   // skus are deactivated, never deleted
    activate(): void { this.active = true; }

    getId(): string { return this.id; }
    getStyleId(): string { return this.styleId; }
    getSkuCode(): string { return this.skuCode; }
    getSize(): string { return this.size; }
    getColor(): string { return this.color; }
    getStandardPriceCents(): number { return this.standardPriceCents; }
    getStandardPrice(): string { return formatCents(this.standardPriceCents); }
    getCurrency(): string { return this.currency; }
    isActive(): boolean { return this.active; }
    getCreatedAt(): Date { return this.createdAt; }
    getUpdatedAt(): Date { return this.updatedAt; }
}

// One row of the price history: who changed the price, from what to what, and when.
export interface PriceChange {
    id: string;
    skuId: string;
    oldPriceCents: number | null;   // null for the first price a sku ever had
    newPriceCents: number;
    effectiveAt: Date;
    changedBy: string;
}
