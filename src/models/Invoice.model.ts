import { ValidationError } from '../utils/exeptions/ValidationError';
import { isUuid } from '../utils/uuid';
import { parseMoneyToCents } from './Money';

export const MAX_UNIT_PRICE_CENTS = 10_000_000;      // 100,000.00 per piece: keeps the total of the lines inside numeric(14,2)

export type CreateInvoiceRequest =
    | { kind: 'b2b'; transferId: string; note: string | null }
    | { kind: 'b2c'; saleId: string; customerName: string | null; customerPhone: string | null; note: string | null };

export interface PriceEdit { skuId: string; unitPriceCents: number }
export interface UpdateInvoiceRequest { prices: PriceEdit[]; note?: string | null }

function asObject(body: unknown): Record<string, unknown> {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new ValidationError('The request body is required');
    return body as Record<string, unknown>;
}
const CONTROL = /[\u0000-\u001f\u007f]/;

function optionalText(value: unknown, label: string, min: number, max: number): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') throw new ValidationError(`${label} must be text`);
    const text = value.trim().replace(/\s+/g, ' ');
    if (text === '') return null;
    if (text.length < min || text.length > max || CONTROL.test(text)) throw new ValidationError(`${label} must be ${min} to ${max} characters`);
    return text;
}

// A phone number: digits, spaces and + - ( ), 5 to 30 characters
function optionalPhone(value: unknown): string | null {
    const text = optionalText(value, 'customerPhone', 5, 30);
    if (text !== null && !/^[0-9+\-() ]+$/.test(text)) throw new ValidationError('customerPhone can have only digits, spaces and + - ( )');
    return text;
}

// "make the invoice of this transfer" (b2b) or "of this sale" (b2c, with the customer's name and phone, both optional): exactly one of the two
export function parseCreateInvoice(body: unknown): CreateInvoiceRequest {
    const input = asObject(body);
    const hasTransfer = input.transferId !== undefined, hasSale = input.saleId !== undefined;
    if (hasTransfer === hasSale) throw new ValidationError('Send either transferId (a supply invoice) or saleId (the invoice of a sale), not both and not neither');
    const note = optionalText(input.note, 'note', 1, 200);
    if (hasTransfer) {
        if (typeof input.transferId !== 'string' || !isUuid(input.transferId)) throw new ValidationError('transferId must be the id of a transfer');
        for (const field of ['customerName', 'customerPhone']) if (input[field] !== undefined) throw new ValidationError('A supply invoice is addressed to the branch: customerName and customerPhone are for the invoice of a sale');
        return { kind: 'b2b', transferId: input.transferId, note };
    }
    if (typeof input.saleId !== 'string' || !isUuid(input.saleId)) throw new ValidationError('saleId must be the id of a sale');
    return { kind: 'b2c', saleId: input.saleId, customerName: optionalText(input.customerName, 'customerName', 2, 100), customerPhone: optionalPhone(input.customerPhone), note };
}

// changing the prices of a DRAFT supply invoice: { "lines": [ { "skuId": "...", "unitPrice": "27.50" } ], "note": "..." }
export function parseInvoiceUpdate(body: unknown): UpdateInvoiceRequest {
    const input = asObject(body);
    const unknown = Object.keys(input).filter((key) => !['lines', 'note'].includes(key));
    if (unknown.length > 0) throw new ValidationError('You can change only: lines (the prices) and note');
    if (input.lines === undefined && input.note === undefined) throw new ValidationError('Nothing to change');
    const prices: PriceEdit[] = [];
    if (input.lines !== undefined) {
        if (!Array.isArray(input.lines) || input.lines.length === 0 || input.lines.length > 200) throw new ValidationError('lines must be a list of 1 to 200 prices');
        for (const [index, raw] of input.lines.entries()) {
            const line = asObject(raw);
            const where = `Line ${index + 1}`;
            if (typeof line.skuId !== 'string' || !isUuid(line.skuId)) throw new ValidationError(`${where}: skuId must be the id of a sku`);
            if (line.unitPrice === undefined || line.unitPrice === null) throw new ValidationError(`${where}: unitPrice is required`);
            if (typeof line.unitPrice !== 'string' && typeof line.unitPrice !== 'number') throw new ValidationError(`${where}: unitPrice must be text or a number`);
            const unitPriceCents = parseMoneyToCents(line.unitPrice, `${where}: unitPrice`);
            if (unitPriceCents > MAX_UNIT_PRICE_CENTS) throw new ValidationError(`${where}: unitPrice is too large`);
            prices.push({ skuId: line.skuId, unitPriceCents });
        }
        if (new Set(prices.map((p) => p.skuId)).size !== prices.length) throw new ValidationError('Each product can appear only once');
    }
    const note = input.note === undefined ? undefined : optionalText(input.note, 'note', 1, 200);
    return { prices, note };
}

export function parseVoidReason(body: unknown): string {
    const reason = asObject(body).reason;
    if (typeof reason !== 'string' || reason.trim().length < 3 || reason.trim().length > 200) throw new ValidationError('reason is required: 3 to 200 characters saying why the invoice is void');
    return reason.trim();
}

// what a line adds up to, in cents
export const lineTotalCents = (quantity: number, unitPriceCents: number, discountCents = 0): number => quantity * unitPriceCents - discountCents;
