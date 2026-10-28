import { createHash } from 'node:crypto';
import { parseMoneyToCents } from '../../models/Money';
import { PaymentMethod, SaleChannel, SaleLineInput, SocialPlatform } from '../../models/SaleLine.model';
import { PaymentInput } from '../../models/SalePayment.model';
import { ValidationError } from '../../utils/exeptions/ValidationError';
import { isUuid } from '../../utils/uuid';

// What the client sends, checked and turned into plain, exact values. Pure: no database here.
export interface SaleRequestLine {
    skuId: string;
    quantity: number;
    discount: null | { type: 'percent'; percentHundredths: number; reason: string } | { type: 'override'; unitPriceCents: number; reason: string };
}

export interface SaleRequest {
    branchId: string;
    channel: SaleChannel;
    socialPlatform: SocialPlatform | null;
    note: string | null;
    lines: SaleRequestLine[];
    payments: PaymentInput[];
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseIdempotencyKey(value: unknown): string {
    if (typeof value !== 'string' || value.trim().length < 8 || value.trim().length > 200) {
        throw new ValidationError('The Idempotency-Key header is required (8 to 200 characters): send a new random id for each sale');
    }
    return value.trim();
}

function parseMoneyValue(value: unknown, label: string): number {
    if (typeof value !== 'string' && typeof value !== 'number') {
        throw new ValidationError(`${label} must be a number or text`);
    }
    return parseMoneyToCents(value, label);
}

function parseDiscount(value: unknown): SaleRequestLine['discount'] {
    if (value === undefined || value === null) return null;
    if (!isObject(value)) throw new ValidationError('discount must be an object');
    if (value.type === 'percent') {
        const pct = parseMoneyValue(value.percent, 'Discount percent');   // "10" -> 1000, "12.5" -> 1250: percent with 2 decimals
        if (typeof value.reason !== 'string') throw new ValidationError('Discount reason must be text');
        return { type: 'percent', percentHundredths: pct, reason: value.reason };
    }
    if (value.type === 'override') {
        const unitPriceCents = parseMoneyValue(value.unitPrice, 'Override unit price');
        if (typeof value.reason !== 'string') throw new ValidationError('Discount reason must be text');
        return { type: 'override', unitPriceCents, reason: value.reason };
    }
    throw new ValidationError('discount.type must be percent or override');
}

export function parseSaleRequest(body: unknown): SaleRequest {
    if (!isObject(body)) throw new ValidationError('The request body is required');
    if (typeof body.branchId !== 'string' || !isUuid(body.branchId)) throw new ValidationError('branchId must be the id of a branch');
    if (!Array.isArray(body.lines) || body.lines.length === 0) throw new ValidationError('A sale needs at least one line');
    if (body.lines.length > 200 || (Array.isArray(body.payments) && body.payments.length > 20)) throw new ValidationError('The request is too big');
    if (body.payments !== undefined && !Array.isArray(body.payments)) throw new ValidationError('payments must be a list');

    const lines = body.lines.map((raw, index): SaleRequestLine => {
        if (!isObject(raw)) throw new ValidationError(`Line ${index + 1} must be an object`);
        if (typeof raw.skuId !== 'string' || !isUuid(raw.skuId)) throw new ValidationError(`Line ${index + 1}: skuId must be the id of a sku`);
        if (typeof raw.quantity !== 'number' || !Number.isInteger(raw.quantity)) throw new ValidationError(`Line ${index + 1}: quantity must be a whole number`);
        return { skuId: raw.skuId, quantity: raw.quantity, discount: parseDiscount(raw.discount) };
    });

    const payments = ((body.payments as unknown[] | undefined) ?? []).map((raw, index): PaymentInput => {
        if (!isObject(raw)) throw new ValidationError(`Payment ${index + 1} must be an object`);
        if (raw.method !== 'cash' && raw.method !== 'whish') throw new ValidationError(`Payment ${index + 1}: method must be cash or whish`);
        const method: PaymentMethod = raw.method;
        const payment: PaymentInput = { method, amountCents: parseMoneyValue(raw.amount, 'Payment amount') };
        if (raw.tendered !== undefined && raw.tendered !== null) payment.tenderedCents = parseMoneyValue(raw.tendered, 'Cash given');
        if (raw.reference !== undefined && raw.reference !== null) {
            if (typeof raw.reference !== 'string') throw new ValidationError('The Whish reference must be text');
            payment.whishReference = raw.reference;
        }
        return payment;
    });

    const channel = (body.channel ?? 'in_store') as SaleChannel;
    return {
        branchId: body.branchId,
        channel,
        socialPlatform: (body.socialPlatform ?? null) as SocialPlatform | null,
        note: (body.note ?? null) as string | null,
        lines,
        payments,
    };
}

// A fingerprint of the request: the same key with the SAME request replays, with ANOTHER request is refused.
export function hashSaleRequest(request: SaleRequest): string {
    const canonical = {
        b: request.branchId,
        c: request.channel,
        p: request.socialPlatform,
        n: request.note,
        l: request.lines.map((l) => [l.skuId, l.quantity, l.discount ? [l.discount.type, 'percentHundredths' in l.discount ? l.discount.percentHundredths : l.discount.unitPriceCents, l.discount.reason] : null]),
        m: request.payments.map((p) => [p.method, p.amountCents, p.tenderedCents ?? null, p.whishReference?.trim() ?? null]),
    };
    return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function toLineInputs(request: SaleRequest, priceOf: (skuId: string) => number, approvedBy: string): SaleLineInput[] {
    return request.lines.map((line) => ({
        skuId: line.skuId,
        quantity: line.quantity,
        unitPriceStandardCents: priceOf(line.skuId),
        reduction: line.discount ? { ...line.discount, approvedBy } : undefined,
    }));
}
