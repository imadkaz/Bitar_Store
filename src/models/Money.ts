import { ValidationError } from '../utils/exeptions/ValidationError';

// Money is kept as whole CENTS inside the domain (an integer: no floating point rounding surprises)
// and travels in JSON as a string with 2 decimals, e.g. "25.00".
const MAX_CENTS = 999_999_999_999;   // numeric(12,2) holds up to 9,999,999,999.99

export function parseMoneyToCents(value: number | string, label: string): number {
    const message = `${label} must be a number zero or greater with at most 2 decimals`;
    let text: string;
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new ValidationError(message);
        text = String(value);                // 25 -> "25", 25.5 -> "25.5"; 0.1 + 0.2 -> "0.30000000000000004" (refused below)
    } else if (typeof value === 'string') {
        text = value.trim();
    } else {
        throw new ValidationError(`${label} is required`);
    }
    const match = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(text);
    if (!match) throw new ValidationError(message);
    const cents = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
    if (cents > MAX_CENTS) throw new ValidationError(`${label} is too large`);
    return cents;
}

export function assertCents(cents: number, label: string): void {
    if (!Number.isInteger(cents) || cents < 0 || cents > MAX_CENTS) {
        throw new ValidationError(`${label} must be a whole number of cents between 0 and ${MAX_CENTS}`);
    }
}

export function formatCents(cents: number): string {
    return `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}
