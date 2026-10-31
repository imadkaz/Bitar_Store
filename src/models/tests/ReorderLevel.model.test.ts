import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../utils/exeptions/ValidationError';
import { parseReorderQuantities, suggestedQuantity } from '../ReorderLevel.model';

describe('parseReorderQuantities', () => {
    it('accepts a minimum with or without a target', () => {
        expect(parseReorderQuantities(5, undefined)).toEqual({ min: 5, target: null });
        expect(parseReorderQuantities(5, null)).toEqual({ min: 5, target: null });
        expect(parseReorderQuantities(5, 12)).toEqual({ min: 5, target: 12 });
        expect(parseReorderQuantities(0, 0)).toEqual({ min: 0, target: 0 });
        expect(parseReorderQuantities(5, 5)).toEqual({ min: 5, target: 5 });
    });

    it('refuses everything else', () => {
        for (const min of [-1, 1.5, '5', null, undefined, 1_000_001, NaN]) expect(() => parseReorderQuantities(min, undefined), String(min)).toThrow(ValidationError);
        for (const target of [4, 1.5, '9', 1_000_001]) expect(() => parseReorderQuantities(5, target), String(target)).toThrow(ValidationError);
    });
});

describe('suggestedQuantity: what to send', () => {
    it('nothing when the branch has the minimum or more', () => {
        expect(suggestedQuantity(5, 0, 5, null)).toBe(0);
        expect(suggestedQuantity(9, 0, 5, 20)).toBe(0);
    });

    it('fills up to the minimum when there is no target', () => {
        expect(suggestedQuantity(2, 0, 5, null)).toBe(3);
        expect(suggestedQuantity(0, 0, 5, null)).toBe(5);
    });

    it('fills up to the target when there is one', () => {
        expect(suggestedQuantity(2, 0, 5, 20)).toBe(18);
    });

    it('counts what is already on the road, so the warehouse does not send twice', () => {
        expect(suggestedQuantity(2, 3, 5, null)).toBe(0);       // 2 here + 3 coming = the minimum
        expect(suggestedQuantity(2, 1, 5, 20)).toBe(17);        // 20 - (2 + 1)
    });
});
