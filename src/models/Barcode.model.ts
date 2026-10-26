import { ValidationError } from '../utils/exeptions/ValidationError';

// What a scanner types: visible characters only, no spaces, 1 to 64 of them. The case is kept exactly as scanned.
export function normalizeBarcode(code: string): string {
    if (typeof code !== 'string') throw new ValidationError('Barcode is required');
    const trimmed = code.trim();
    if (trimmed.length === 0) throw new ValidationError('Barcode is required');
    if (trimmed.length > 64) throw new ValidationError('Barcode must be at most 64 characters');
    if (!/^[\x21-\x7E]+$/.test(trimmed)) throw new ValidationError('Barcode may not contain spaces or special characters');
    return trimmed;
}

export interface BarcodeProps {
    id: string;
    skuId: string;
    code: string;
    createdAt?: Date;
}

// One sku can have many barcodes; one barcode belongs to exactly one sku (unique across the whole catalog).
export class Barcode {
    private constructor(
        private readonly id: string,
        private readonly skuId: string,
        private readonly code: string,
        private readonly createdAt: Date,
    ) {}

    static create(props: BarcodeProps): Barcode {
        return new Barcode(props.id, props.skuId, normalizeBarcode(props.code), props.createdAt ?? new Date());
    }

    getId(): string { return this.id; }
    getSkuId(): string { return this.skuId; }
    getCode(): string { return this.code; }
    getCreatedAt(): Date { return this.createdAt; }
}
