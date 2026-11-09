import { ValidationError } from '../utils/exeptions/ValidationError';

// What the managers set for the whole business. A setting never set has its default here.
export interface Settings {
    exchangeRateUsdLbp: number | null;     // how many Lebanese pounds for one dollar (a whole number); null until a manager sets it
    returnPeriodDays: number;              // a customer return is accepted this many days after the sale
    defaultReservationDays: number;        // how long a reserved order is kept by default
    requireOpenCashSession: boolean;       // true: a sale cannot be completed without an open cash session at its branch
}

export const DEFAULT_SETTINGS: Settings = { exchangeRateUsdLbp: null, returnPeriodDays: 14, defaultReservationDays: 3, requireOpenCashSession: false };
export const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[];

const whole = (value: unknown, label: string, min: number, max: number): number => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new ValidationError(`${label} must be a whole number from ${min} to ${max}`);
    return value;
};

// a partial update: only what is sent changes; exchangeRateUsdLbp can be sent as null to clear it
export function parseSettingsUpdate(body: unknown): Partial<Settings> {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new ValidationError('The request body is required');
    const input = body as Record<string, unknown>;
    const unknown = Object.keys(input).filter((k) => !SETTING_KEYS.includes(k as keyof Settings));
    if (unknown.length > 0) throw new ValidationError(`Unknown setting: ${unknown.join(', ')}`);
    const out: Partial<Settings> = {};
    if (input.exchangeRateUsdLbp !== undefined) out.exchangeRateUsdLbp = input.exchangeRateUsdLbp === null ? null : whole(input.exchangeRateUsdLbp, 'exchangeRateUsdLbp', 1, 10_000_000);
    if (input.returnPeriodDays !== undefined) out.returnPeriodDays = whole(input.returnPeriodDays, 'returnPeriodDays', 0, 365);
    if (input.defaultReservationDays !== undefined) out.defaultReservationDays = whole(input.defaultReservationDays, 'defaultReservationDays', 1, 60);
    if (input.requireOpenCashSession !== undefined) {
        if (typeof input.requireOpenCashSession !== 'boolean') throw new ValidationError('requireOpenCashSession must be true or false');
        out.requireOpenCashSession = input.requireOpenCashSession;
    }
    if (Object.keys(out).length === 0) throw new ValidationError('Nothing to change');
    return out;
}
