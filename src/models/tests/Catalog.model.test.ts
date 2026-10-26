import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../utils/exeptions/ValidationError';
import { Barcode, normalizeBarcode } from '../Barcode.model';
import { Sku, normalizeCurrency, normalizeSkuCode } from '../Sku.model';
import { Style, normalizeStyleCode, validateCategory } from '../Style.model';

describe('Style', () => {
    it('normalizes the code to upper case and refuses odd characters', () => {
        expect(normalizeStyleCode(' nk-100/a.b_c ')).toBe('NK-100/A.B_C');
        for (const bad of [undefined, null, 5, '', '  ', 'has space', '-start', '$$', 'ü', 'A'.repeat(41)]) expect(() => normalizeStyleCode(bad), String(bad)).toThrow(ValidationError);
    });

    it('treats an empty category as "none" and refuses non-text', () => {
        expect(validateCategory(undefined)).toBeNull();
        expect(validateCategory(null)).toBeNull();
        expect(validateCategory('   ')).toBeNull();
        expect(validateCategory(' Tops ')).toBe('Tops');
        expect(() => validateCategory(5)).toThrow(ValidationError);
        expect(() => validateCategory('x'.repeat(61))).toThrow(ValidationError);
    });

    it('rename and changeCategory validate; deactivate flips the flag; the code has no setter', () => {
        const style = Style.create({ id: 'a', code: 'x1', name: 'Tee' });
        style.rename(' New name ');
        style.changeCategory('');
        style.deactivate();
        expect([style.getName(), style.getCategory(), style.isActive(), style.getCode()]).toEqual(['New name', null, false, 'X1']);
        expect(() => style.rename(' ')).toThrow(ValidationError);
        expect((style as unknown as Record<string, unknown>).setCode).toBeUndefined();
    });
});

describe('Sku', () => {
    const make = (patch = {}) => Sku.create({ id: 'a', styleId: 's', skuCode: 'nk-1', size: 'M', color: 'Red', standardPriceCents: 2500, ...patch });

    it('normalizes the code, size, color and currency', () => {
        const sku = make({ skuCode: ' nk-1 ', size: ' M ', color: ' Red ', currency: 'eur' });
        expect([sku.getSkuCode(), sku.getSize(), sku.getColor(), sku.getCurrency()]).toEqual(['NK-1', 'M', 'Red', 'EUR']);
        expect(make().getCurrency()).toBe('USD');
        expect(normalizeSkuCode('a.b/c-1')).toBe('A.B/C-1');
        expect(() => normalizeCurrency('EURO')).toThrow(ValidationError);
        expect(() => normalizeCurrency(5)).toThrow(ValidationError);
    });

    it('refuses bad sizes, colors, codes and prices at creation', () => {
        for (const patch of [{ size: ' ' }, { size: 'S'.repeat(21) }, { color: '' }, { color: 'C'.repeat(41) }, { skuCode: 'has space' }, { standardPriceCents: -1 }, { standardPriceCents: 1.5 }, { standardPriceCents: 1e13 }]) {
            expect(() => make(patch), JSON.stringify(patch)).toThrow(ValidationError);
        }
    });

    it('changePrice says whether anything changed, and shows the price with 2 decimals', () => {
        const sku = make();
        expect(sku.getStandardPrice()).toBe('25.00');
        expect(sku.changePrice(2500)).toBe(false);
        expect(sku.changePrice(3050)).toBe(true);
        expect(sku.getStandardPrice()).toBe('30.50');
        expect(() => sku.changePrice(-5)).toThrow(ValidationError);
        expect(sku.getStandardPriceCents()).toBe(3050);
    });

    it('size and color can change; the code and the currency cannot', () => {
        const sku = make();
        sku.changeSize('XL');
        sku.changeColor('Green');
        expect([sku.getSize(), sku.getColor()]).toEqual(['XL', 'Green']);
        expect((sku as unknown as Record<string, unknown>).changeSkuCode).toBeUndefined();
        expect((sku as unknown as Record<string, unknown>).changeCurrency).toBeUndefined();
    });
});

describe('Barcode', () => {
    it('keeps the case, trims, and accepts visible characters only', () => {
        expect(normalizeBarcode(' AbC-123 ')).toBe('AbC-123');
        expect(Barcode.create({ id: 'a', skuId: 's', code: '5901234123457' }).getCode()).toBe('5901234123457');
        for (const bad of [undefined, 5, '', '  ', 'two words', 'tab\there', 'ü', 'x'.repeat(65)]) expect(() => normalizeBarcode(bad), String(bad)).toThrow(ValidationError);
    });
});
