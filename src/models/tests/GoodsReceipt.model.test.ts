import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../utils/exeptions/ValidationError';
import { parseGoodsReceipt, totalCostCents } from '../GoodsReceipt.model';

const NOW = new Date('2026-11-03T10:00:00Z');
const sku = randomUUID();
const body = (patch: Record<string, unknown> = {}) => ({ supplierName: 'Textile Co', supplierInvoiceNumber: 'INV-2041', invoiceDate: '2026-11-01', lines: [{ skuId: sku, quantity: 20, unitCost: '12.50' }], ...patch });

describe('parseGoodsReceipt', () => {
    it('takes the supplier, the invoice number, the date and the products, and makes them exact', () => {
        const parsed = parseGoodsReceipt(body({ supplierName: '  Textile   Co ', supplierInvoiceNumber: ' INV-2041 ', note: ' First delivery ', currency: 'usd' }), NOW);
        expect(parsed).toMatchObject({ supplierName: 'Textile Co', supplierInvoiceNumber: 'INV-2041', invoiceDate: '2026-11-01', currency: 'USD', note: 'First delivery' });
        expect(parsed.lines).toEqual([{ skuId: sku, quantity: 20, unitCostCents: 1250 }]);
        expect(totalCostCents(parsed.lines)).toBe(25_000);
    });

    it('the date is today when it is not given; the invoice number may be a number; the cost may be a number or a string', () => {
        expect(parseGoodsReceipt(body({ invoiceDate: undefined }), NOW).invoiceDate).toBe('2026-11-03');
        expect(parseGoodsReceipt(body({ supplierInvoiceNumber: 20410 }), NOW).supplierInvoiceNumber).toBe('20410');
        expect(parseGoodsReceipt(body({ lines: [{ skuId: sku, quantity: 1, unitCost: 7 }] }), NOW).lines[0].unitCostCents).toBe(700);
        expect(parseGoodsReceipt(body({ lines: [{ skuId: sku, quantity: 1, unitCost: 0 }] }), NOW).lines[0].unitCostCents).toBe(0);
    });

    it('adds up the whole invoice without rounding', () => {
        const lines = [{ skuId: randomUUID(), quantity: 3, unitCostCents: 1999 }, { skuId: randomUUID(), quantity: 10_000, unitCostCents: 10_000_000 }];
        expect(totalCostCents(lines)).toBe(3 * 1999 + 10_000 * 10_000_000);
    });

    it('refuses what is wrong, clearly', () => {
        const bad: Record<string, unknown>[] = [
            { supplierName: undefined }, { supplierName: 'X' }, { supplierName: '   ' }, { supplierName: 'x'.repeat(101) }, { supplierName: 5 },
            { supplierInvoiceNumber: undefined }, { supplierInvoiceNumber: '' }, { supplierInvoiceNumber: 'x'.repeat(51) }, { supplierInvoiceNumber: 'A\u0000B' },
            { invoiceDate: '2026-11-04' }, { invoiceDate: '2026-02-30' }, { invoiceDate: '03/11/2026' }, { invoiceDate: 20261101 },
            { currency: 'dollars' }, { note: 'x'.repeat(201) }, { note: 5 },
            { lines: undefined }, { lines: [] }, { lines: 'x' }, { lines: Array.from({ length: 201 }, () => ({ skuId: randomUUID(), quantity: 1, unitCost: '1.00' })) },
            { lines: [{ skuId: 'abc', quantity: 1, unitCost: '1.00' }] }, { lines: [{ skuId: sku, quantity: 0, unitCost: '1.00' }] }, { lines: [{ skuId: sku, quantity: 1.5, unitCost: '1.00' }] },
            { lines: [{ skuId: sku, quantity: 10_001, unitCost: '1.00' }] }, { lines: [{ skuId: sku, quantity: '2', unitCost: '1.00' }] },
            { lines: [{ skuId: sku, quantity: 1 }] }, { lines: [{ skuId: sku, quantity: 1, unitCost: '-1' }] }, { lines: [{ skuId: sku, quantity: 1, unitCost: '1.005' }] }, { lines: [{ skuId: sku, quantity: 1, unitCost: 'abc' }] },
            { lines: [{ skuId: sku, quantity: 1, unitCost: '100000.01' }] },
            { lines: [{ skuId: sku, quantity: 1, unitCost: '1.00' }, { skuId: sku, quantity: 2, unitCost: '1.00' }] },
        ];
        for (const patch of bad) expect(() => parseGoodsReceipt(body(patch), NOW), JSON.stringify(patch).slice(0, 80)).toThrow(ValidationError);
        for (const input of [undefined, null, 'x', [], 5]) expect(() => parseGoodsReceipt(input, NOW), String(input)).toThrow(ValidationError);
    });
});
