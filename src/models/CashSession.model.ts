import { businessDateOf } from '../utils/businessDate';
import { ValidationError } from '../utils/exeptions/ValidationError';
import { isUuid } from '../utils/uuid';
import { parseMoneyToCents } from './Money';

export const MAX_CASH_CENTS = 100_000_000;       // 1,000,000.00: keeps every total inside numeric(12,2)

function asObject(body: unknown): Record<string, unknown> {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new ValidationError('The request body is required');
    return body as Record<string, unknown>;
}
const CONTROL = /[\u0000-\u001f\u007f]/;

function required(value: unknown, label: string): number {
    if (value === undefined || value === null) throw new ValidationError(`${label} is required`);
    const cents = parseMoneyToCents(value as string | number, label);
    if (cents < 0 || cents > MAX_CASH_CENTS) throw new ValidationError(`${label} must be between 0 and 1,000,000.00`);
    return cents;
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

// "the physically counted cash in the drawer when the session starts"
export function parseOpenSession(body: unknown): { branchId: string; openingCents: number; note: string | null } {
    const input = asObject(body);
    if (typeof input.branchId !== 'string' || !isUuid(input.branchId)) throw new ValidationError('branchId must be the id of a branch');
    return { branchId: input.branchId, openingCents: required(input.openingCash, 'openingCash'), note: optionalText(input.note, 'note', 200) };
}

// cash added to or taken from the drawer outside the sales: amount, direction and reason
export function parseCashMovement(body: unknown): { direction: 'in' | 'out'; amountCents: number; reason: string } {
    const input = asObject(body);
    if (input.direction !== 'in' && input.direction !== 'out') throw new ValidationError('direction must be in or out');
    const amountCents = required(input.amount, 'amount');
    if (amountCents <= 0) throw new ValidationError('amount must be more than zero');
    return { direction: input.direction, amountCents, reason: text(input.reason, 'reason', 3, 200) };
}

// the person TAKING the drawer says what they counted; a note is needed when it differs from what is expected (checked against the session)
export function parseHandover(body: unknown): { countedCents: number; note: string | null } {
    const input = asObject(body);
    return { countedCents: required(input.countedCash, 'countedCash'), note: optionalText(input.note, 'note', 200) };
}

// the closing: the cash counted, what is taken out of the drawer, and the explanation when the count differs from what is expected
export function parseCloseSession(body: unknown): { countedCents: number; removedCents: number; differenceNote: string | null } {
    const input = asObject(body);
    const countedCents = required(input.countedCash, 'countedCash');
    const removedCents = input.cashRemoved === undefined || input.cashRemoved === null ? 0 : required(input.cashRemoved, 'cashRemoved');
    if (removedCents > countedCents) throw new ValidationError('cashRemoved cannot be more than the cash counted');
    return { countedCents, removedCents, differenceNote: optionalText(input.differenceNote, 'differenceNote', 200) };
}

export type CorrectionField = 'opening_cash' | 'counted_cash' | 'cash_removed';
const FIELDS: Record<string, CorrectionField> = { openingCash: 'opening_cash', countedCash: 'counted_cash', cashRemoved: 'cash_removed' };

export function parseCorrection(body: unknown): { field: CorrectionField; valueCents: number; reason: string } {
    const input = asObject(body);
    const field = typeof input.field === 'string' ? FIELDS[input.field] : undefined;
    if (!field) throw new ValidationError('field must be openingCash, countedCash or cashRemoved');
    return { field, valueCents: required(input.value, 'value'), reason: text(input.reason, 'reason', 3, 200) };
}

export function parseReview(body: unknown): { note: string | null } {
    return { note: optionalText(body === undefined ? undefined : asObject(body).note, 'note', 200) };
}

// Expected physical cash = what the drawer started with + the cash payments + cash added - cash taken out.
// (Whish never changes the drawer. A cash refund of a return is taken off: it came out of this drawer.)
export const expectedCashCents = (parts: { openingCents: number; cashPaymentsCents: number; cashInCents: number; cashOutCents: number; cashRefundsCents?: number }): number =>
    parts.openingCents + parts.cashPaymentsCents + parts.cashInCents - parts.cashOutCents - (parts.cashRefundsCents ?? 0);

// closed on another day than it was opened (Beirut): flagged as a late closing, never closed by itself
export const isLateClosing = (openedAt: Date, closedAt: Date): boolean => businessDateOf(openedAt) !== businessDateOf(closedAt);
