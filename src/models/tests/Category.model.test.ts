import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../utils/exeptions/ValidationError';
import { normalizeCategoryName } from '../Category.model';

describe('normalizeCategoryName', () => {
    it('trims and squeezes spaces, keeps the spelling', () => {
        expect(normalizeCategoryName('  Evening   Wear ')).toBe('Evening Wear');
        expect(normalizeCategoryName('T-Shirts')).toBe('T-Shirts');
        expect(normalizeCategoryName('فساتين')).toBe('فساتين');
        expect(normalizeCategoryName('x'.repeat(60))).toHaveLength(60);
    });

    it('refuses empty, too long, non-text and control characters', () => {
        for (const bad of ['', '   ', 'x'.repeat(61), null, undefined, 5, {}, 'a\u0000b']) expect(() => normalizeCategoryName(bad), String(bad)).toThrow(ValidationError);
    });
});
