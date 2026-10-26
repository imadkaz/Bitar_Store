import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../utils/exeptions/ValidationError';
import { assertCents, formatCents, parseMoneyToCents } from '../Money';

describe('money in cents', () => {
    it('reads strings and numbers into exact cents', () => {
        const cases: [unknown, number][] = [['25', 2500], ['25.5', 2550], ['25.05', 2505], [' 7.99 ', 799], [0, 0], ['0.00', 0], [19.99, 1999], [0.29, 29], [1.1, 110], ['9999999999.99', 999999999999]];
        for (const [input, cents] of cases) expect(parseMoneyToCents(input, 'Price')).toBe(cents);
    });

    it('refuses anything that is not a plain non-negative amount with at most 2 decimals', () => {
        const bad: unknown[] = ['', ' ', 'abc', '-1', -1, '1.234', '1,5', '1e3', 0.1 + 0.2, NaN, Infinity, 1e21, '10000000000.00', '.5', '5.', null, undefined, {}, [], true];
        for (const input of bad) expect(() => parseMoneyToCents(input, 'Price'), JSON.stringify(input)).toThrow(ValidationError);
    });

    it('says which field was wrong', () => {
        expect(() => parseMoneyToCents('x', 'Standard price')).toThrow('Standard price must be a number zero or greater with at most 2 decimals');
        expect(() => parseMoneyToCents(undefined, 'Price')).toThrow('Price is required');
    });

    it('formats cents back to a 2-decimal string and round-trips', () => {
        expect(formatCents(0)).toBe('0.00');
        expect(formatCents(7)).toBe('0.07');
        expect(formatCents(2550)).toBe('25.50');
        expect(formatCents(999999999999)).toBe('9999999999.99');
        for (const cents of [0, 1, 99, 100, 101, 123456, 999999999999]) expect(parseMoneyToCents(formatCents(cents), 'Price')).toBe(cents);
    });

    it('assertCents accepts only whole, non-negative, in-range numbers', () => {
        expect(() => assertCents(2500, 'Price')).not.toThrow();
        for (const bad of [-1, 1.5, NaN, 1e13]) expect(() => assertCents(bad, 'Price')).toThrow(ValidationError);
    });
});
