import { ValidationError } from '../utils/exeptions/ValidationError';
import { isUuid } from '../utils/uuid';
import { parseMoneyToCents } from './Money';

export const RETURN_CONDITIONS = ['as_new', 'minor_flaws', 'needs_repair', 'damaged'] as const;
export type ReturnCondition = (typeof RETURN_CONDITIONS)[number];
export const MAX_RETURN_LINES = 50;
export const MAX_REFUND_CENTS = 100_000_000;            // 1,000,000.00: keeps the sums inside numeric(12,2)
const CONTROL = /[\u0000-\u001f\u007f]/;

export interface ReturnLineRequest { skuId: string; quantity: number; condition: ReturnCondition }
export interface CreateReturnRequest {
    saleId: string;
    receivingBranchId: string;
    custody: 'with_branch' | 'customer_keeps';
    reason: string;
    note: string | null;
    lines: ReturnLineRequest[];
    lateExceptionReason: string | null;      // a manager's exception when the return is outside the return period
}

function asObject(body: unknown): Record<string, unknown> {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new ValidationError('The request body is required');
    return body as Record<string, unknown>;
}
function text(value: unknown, label: string, min: number, max: number): string {
    if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max || CONTROL.test(value)) throw new ValidationError(`${label} must be ${min} to ${max} characters`);
    return value.trim().replace(/\s+/g, ' ');
}
function optionalText(value: unknown, label: string, max: number): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string' || value.trim().length > max || CONTROL.test(value)) throw new ValidationError(`${label} must be at most ${max} characters`);
    return value.trim() === '' ? null : value.trim().replace(/\s+/g, ' ');
}

// What the person at the counter records: the sale, the branch that takes the goods, what comes back, why, and in what condition. Pure: no database here.
export function parseCreateReturn(body: unknown): CreateReturnRequest {
    const input = asObject(body);
    if (typeof input.saleId !== 'string' || !isUuid(input.saleId)) throw new ValidationError('saleId must be the id of the sale being returned');
    if (typeof input.receivingBranchId !== 'string' || !isUuid(input.receivingBranchId)) throw new ValidationError('receivingBranchId must be the id of the branch that takes the goods');
    const custody = input.custody === undefined ? 'with_branch' : input.custody;
    if (custody !== 'with_branch' && custody !== 'customer_keeps') throw new ValidationError('custody must be with_branch or customer_keeps');
    if (!Array.isArray(input.lines) || input.lines.length === 0) throw new ValidationError('lines must be a list with at least one product');
    if (input.lines.length > MAX_RETURN_LINES) throw new ValidationError(`At most ${MAX_RETURN_LINES} products in one return`);
    const lines = input.lines.map((raw, index): ReturnLineRequest => {
        const line = asObject(raw);
        const where = `Line ${index + 1}`;
        if (typeof line.skuId !== 'string' || !isUuid(line.skuId)) throw new ValidationError(`${where}: skuId must be the id of a sku`);
        if (typeof line.quantity !== 'number' || !Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 10_000) throw new ValidationError(`${where}: quantity must be a whole number from 1 to 10000`);
        if (!RETURN_CONDITIONS.includes(line.condition as ReturnCondition)) throw new ValidationError(`${where}: condition must be one of: ${RETURN_CONDITIONS.join(', ')}`);
        return { skuId: line.skuId, quantity: line.quantity, condition: line.condition as ReturnCondition };
    });
    if (new Set(lines.map((l) => l.skuId)).size !== lines.length) throw new ValidationError('Each product can appear only once in a return');
    let lateExceptionReason: string | null = null;
    if (input.lateException !== undefined && input.lateException !== null) lateExceptionReason = text(asObject(input.lateException).reason, 'lateException.reason', 3, 200);
    return { saleId: input.saleId, receivingBranchId: input.receivingBranchId, custody, reason: text(input.reason, 'reason', 3, 200), note: optionalText(input.note, 'note', 200), lines, lateExceptionReason };
}

export const parseRejection = (body: unknown): { reason: string } => ({ reason: text(asObject(body).reason, 'reason', 3, 200) });
export const parseApproval = (body: unknown): { reason: string | null } => ({ reason: body === undefined ? null : optionalText(asObject(body).reason, 'reason', 200) });
export const parseHandback = (body: unknown): { recipient: string } => ({ recipient: text(asObject(body).recipient, 'recipient', 2, 100) });

// release: nothing sent = everything still on hold; or a list of { returnLineId, quantity }
export function parseRelease(body: unknown): { lines: { returnLineId: string; quantity: number }[] | null } {
    if (body === undefined || body === null) return { lines: null };
    const input = asObject(body);
    if (input.lines === undefined) return { lines: null };
    if (!Array.isArray(input.lines) || input.lines.length === 0 || input.lines.length > MAX_RETURN_LINES) throw new ValidationError('lines must be a list of 1 to 50 products');
    const lines = input.lines.map((raw, index) => {
        const line = asObject(raw);
        if (typeof line.returnLineId !== 'string' || !isUuid(line.returnLineId)) throw new ValidationError(`Line ${index + 1}: returnLineId must be the id of a line of the return`);
        if (typeof line.quantity !== 'number' || !Number.isInteger(line.quantity) || line.quantity < 1) throw new ValidationError(`Line ${index + 1}: quantity must be a whole number above zero`);
        return { returnLineId: line.returnLineId, quantity: line.quantity };
    });
    if (new Set(lines.map((l) => l.returnLineId)).size !== lines.length) throw new ValidationError('Each line can appear only once');
    return { lines };
}

// paying (part of) the refund: cash or Whish, the person who receives the money, and a reference for Whish when there is one
export function parseRefundPayment(body: unknown): { method: 'cash' | 'whish'; amountCents: number; recipient: string; reference: string | null } {
    const input = asObject(body);
    if (input.method !== 'cash' && input.method !== 'whish') throw new ValidationError('method must be cash or whish');
    if (input.amount === undefined || input.amount === null) throw new ValidationError('amount is required');
    const amountCents = parseMoneyToCents(input.amount as string | number, 'amount');
    if (amountCents < 1 || amountCents > MAX_REFUND_CENTS) throw new ValidationError('amount must be above zero');
    const reference = optionalText(input.reference, 'reference', 64);
    if (input.method === 'cash' && reference !== null) throw new ValidationError('A cash refund has no reference');
    return { method: input.method, amountCents, recipient: text(input.recipient, 'recipient', 2, 100), reference };
}

// What this return refunds for ONE sale line: what was PAID for the units (the line total after reductions), in proportion to the units returned.
// Cumulative, so several partial returns never refund more than was paid, and returning everything refunds exactly the line total (rounding never leaks a cent).
export function refundValueCents(lineTotalCents: number, soldQuantity: number, approvedBeforeQuantity: number, allocatedBeforeCents: number, returningQuantity: number): number {
    if (returningQuantity < 1 || approvedBeforeQuantity + returningQuantity > soldQuantity) throw new ValidationError('More units than were sold');
    const share = (units: number) => Math.floor((2 * lineTotalCents * units + soldQuantity) / (2 * soldQuantity));      // rounded to the nearest cent, half up
    return Math.max(0, share(approvedBeforeQuantity + returningQuantity) - allocatedBeforeCents);
}
