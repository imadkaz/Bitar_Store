import { ValidationError } from '../utils/exeptions/ValidationError';

// ---- limits ---------------------------------------------------------------------------------------------
export const MAX_LINES = 50;
export const MAX_QUANTITY = 10_000;
export const MAX_PAYMENTS = 4;
export const MAX_CENTS = 999_999_999_999n;   // numeric(12,2)

export const SALE_CHANNELS = ['in_store', 'social_media'] as const;
export type SaleChannel = (typeof SALE_CHANNELS)[number];
export const SOCIAL_PLATFORMS = ['facebook', 'instagram', 'whatsapp', 'other'] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];
export type PaymentMethod = 'cash' | 'whish';

// ---- one discount on one line -----------------------------------------------------------------------------
// Both kinds need a reason and the manager who approved them (BL-04). percentHundredths: 1000 means 10.00 %.
export type Reduction =
    | { type: 'percent'; percentHundredths: number; reason: string; approvedBy: string }
    | { type: 'override'; unitPriceCents: number; reason: string; approvedBy: string };

function cleanReason(reason: string): string {
    if (typeof reason !== 'string' || reason.trim().length === 0) throw new ValidationError('A discount needs a reason');
    const trimmed = reason.trim();
    if (trimmed.length > 200) throw new ValidationError('A discount reason must be at most 200 characters');
    return trimmed;
}

export interface SaleLineInput {
    skuId: string;
    quantity: number;
    unitPriceStandardCents: number;     // the CATALOG price at the moment of the sale, read by the server
    reduction?: Reduction;
}

export class SaleLine {
    private constructor(
        readonly lineNo: number,
        readonly skuId: string,
        readonly quantity: number,
        readonly unitPriceStandardCents: number,
        readonly reduction: Reduction | null,
        readonly lineStandardTotalCents: number,
        readonly lineTotalCents: number,
    ) {}

    static create(lineNo: number, input: SaleLineInput): SaleLine {
        if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > MAX_QUANTITY) {
            throw new ValidationError(`Quantity must be a whole number between 1 and ${MAX_QUANTITY}`);
        }
        const standardTotal = BigInt(input.unitPriceStandardCents) * BigInt(input.quantity);
        if (standardTotal > MAX_CENTS) throw new ValidationError('The total of a line is too large');

        let lineTotal = standardTotal;
        let reduction: Reduction | null = null;
        if (input.reduction) {
            if (input.reduction.type === 'percent') {
                const pct = input.reduction.percentHundredths;
                if (!Number.isInteger(pct) || pct < 1 || pct > 10_000) throw new ValidationError('A percentage discount must be above 0 and at most 100');
                // half-up rounding to the cent, in whole numbers (no floating point)
                lineTotal = (standardTotal * BigInt(10_000 - pct) + 5_000n) / 10_000n;
                reduction = { type: 'percent', percentHundredths: pct, reason: cleanReason(input.reduction.reason), approvedBy: input.reduction.approvedBy };
            } else {
                const price = input.reduction.unitPriceCents;
                if (!Number.isInteger(price) || price < 0) throw new ValidationError('The new unit price cannot be negative');
                if (price > input.unitPriceStandardCents) throw new ValidationError('A price override cannot be higher than the catalog price');
                lineTotal = BigInt(price) * BigInt(input.quantity);
                reduction = { type: 'override', unitPriceCents: price, reason: cleanReason(input.reduction.reason), approvedBy: input.reduction.approvedBy };
            }
        }
        return new SaleLine(lineNo, input.skuId, input.quantity, input.unitPriceStandardCents, reduction, Number(standardTotal), Number(lineTotal));
    }

    getDiscountCents(): number {
        return this.lineStandardTotalCents - this.lineTotalCents;
    }
}