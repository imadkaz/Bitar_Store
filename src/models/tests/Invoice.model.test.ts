import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../utils/exeptions/ValidationError';
import { lineTotalCents, parseCreateInvoice, parseInvoiceUpdate, parseVoidReason } from '../Invoice.model';

describe('parseCreateInvoice', () => {
    it('a supply invoice is made from a transfer', () => {
        const transferId = randomUUID();
        expect(parseCreateInvoice({ transferId, note: ' Winter collection ' })).toEqual({ kind: 'b2b', transferId, note: 'Winter collection', invoiceKind: null });
        expect(parseCreateInvoice({ transferId })).toEqual({ kind: 'b2b', transferId, note: null, invoiceKind: null });
        expect(parseCreateInvoice({ transferId, invoiceKind: 'b2b_return' })).toEqual({ kind: 'b2b', transferId, note: null, invoiceKind: 'b2b_return' });
        expect(() => parseCreateInvoice({ transferId, invoiceKind: 'b2c' })).toThrow();
    });

    it('the invoice of a sale takes the customer name and phone, both optional', () => {
        const saleId = randomUUID();
        expect(parseCreateInvoice({ saleId })).toEqual({ kind: 'b2c', saleId, customerName: null, customerPhone: null, note: null });
        expect(parseCreateInvoice({ saleId, customerName: '  رامي   الخوري ', customerPhone: '+961 3 123-456' })).toMatchObject({ customerName: 'رامي الخوري', customerPhone: '+961 3 123-456' });
        expect(parseCreateInvoice({ saleId, customerName: '', customerPhone: '   ' })).toMatchObject({ customerName: null, customerPhone: null });
        expect(parseCreateInvoice({ saleId, customerName: 'Rami Khoury' })).toMatchObject({ customerName: 'Rami Khoury', customerPhone: null });
        expect(parseCreateInvoice({ saleId, customerPhone: '03 123 456' })).toMatchObject({ customerName: null, customerPhone: '03 123 456' });
    });

    it('refuses what is wrong', () => {
        const id = randomUUID();
        const bad: unknown[] = [
            {}, { transferId: id, saleId: id }, { transferId: 'abc' }, { saleId: 5 }, { transferId: id, customerName: 'Rami' }, { transferId: id, customerPhone: '12345' },
            { saleId: id, customerName: 'R' }, { saleId: id, customerName: 'x'.repeat(101) }, { saleId: id, customerName: 5 }, { saleId: id, customerPhone: '123' }, { saleId: id, customerPhone: 'call me' },
            { saleId: id, customerPhone: '1'.repeat(31) }, { saleId: id, note: 'x'.repeat(201) }, { saleId: id, customerName: 'A\u0000B' },
            undefined, null, 'x', [], 5,
        ];
        for (const body of bad) expect(() => parseCreateInvoice(body), JSON.stringify(body)?.slice(0, 80)).toThrow(ValidationError);
    });
});

describe('parseInvoiceUpdate', () => {
    const sku = randomUUID();
    it('takes the new prices in cents, and a note', () => {
        expect(parseInvoiceUpdate({ lines: [{ skuId: sku, unitPrice: '27.50' }] })).toEqual({ prices: [{ skuId: sku, unitPriceCents: 2750 }], note: undefined });
        expect(parseInvoiceUpdate({ lines: [{ skuId: sku, unitPrice: 30 }], note: ' Agreed price ' })).toEqual({ prices: [{ skuId: sku, unitPriceCents: 3000 }], note: 'Agreed price' });
        expect(parseInvoiceUpdate({ note: 'Only a note' })).toEqual({ prices: [], note: 'Only a note' });
        expect(parseInvoiceUpdate({ lines: [{ skuId: sku, unitPrice: 0 }] }).prices[0].unitPriceCents).toBe(0);
    });

    it('refuses what is wrong', () => {
        const bad: unknown[] = [
            {}, { lines: [] }, { lines: 'x' }, { lines: [{ skuId: 'abc', unitPrice: '1.00' }] }, { lines: [{ skuId: sku }] }, { lines: [{ skuId: sku, unitPrice: '-1' }] }, { lines: [{ skuId: sku, unitPrice: '1.005' }] },
            { lines: [{ skuId: sku, unitPrice: '100000.01' }] }, { lines: [{ skuId: sku, unitPrice: '1.00' }, { skuId: sku, unitPrice: '2.00' }] }, { lines: [{ skuId: sku, unitPrice: '1.00' }], total: 5 }, { status: 'final' },
            { note: 'x'.repeat(201) }, undefined, null, [],
        ];
        for (const body of bad) expect(() => parseInvoiceUpdate(body), JSON.stringify(body)?.slice(0, 80)).toThrow(ValidationError);
    });
});

describe('the rest', () => {
    it('a void needs a reason of 3 to 200 characters', () => {
        expect(parseVoidReason({ reason: '  Wrong price on the caps ' })).toBe('Wrong price on the caps');
        for (const body of [{}, { reason: '' }, { reason: 'ab' }, { reason: 'x'.repeat(201) }, { reason: 5 }, undefined]) expect(() => parseVoidReason(body)).toThrow(ValidationError);
    });

    it('a line is the quantity times the price, minus its discount, in whole cents', () => {
        expect(lineTotalCents(20, 9500)).toBe(190_000);
        expect(lineTotalCents(3, 1999, 150)).toBe(5_847);
    });
});
