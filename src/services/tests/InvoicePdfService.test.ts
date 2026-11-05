import { describe, expect, it } from 'vitest';
import { InvoiceView } from '../../repositories/interfaces/IInvoiceRepository';
import { isRtl, mirrorBrackets, renderInvoicePdf, visualOrder } from '../InvoicePdfService';

describe('right-to-left lines in the PDF', () => {
    it('knows Arabic from Latin', () => {
        expect(isRtl('رامي الخوري')).toBe(true);
        expect(isRtl('Rami Khoury')).toBe(false);
        expect(isRtl('Rami الخوري')).toBe(true);
        expect(isRtl('12345')).toBe(false);
    });

    it('draws the words of an Arabic line from the right: the order is reversed, the brackets face the other way, Latin lines are untouched', () => {
        expect(visualOrder('رامي الخوري')).toBe('الخوري رامي');
        expect(visualOrder('رقم 12 فاتورة')).toBe('فاتورة 12 رقم');
        expect(visualOrder('شركة النور (فرع صيدا)')).toBe('صيدا( )فرع النور شركة');
        expect(visualOrder('Evening Dress, M')).toBe('Evening Dress, M');
        expect(mirrorBrackets('(a)[b]{c}<d>')).toBe(')a(]b[}c{>d<');
    });
});

const invoice = (patch: Partial<InvoiceView> = {}): InvoiceView => ({
    id: '11111111-1111-1111-1111-111111111111', kind: 'b2b', status: 'final', reference: 'B2B-00000001', issuer: { id: 'w', name: 'Main Warehouse' }, recipient: { branchId: 'h', name: 'Hamra', phone: null },
    transfer: { id: 't', reference: 'T-00000001' }, sale: null, currency: 'USD', subtotal: '100.00', discountTotal: '0.00', total: '100.00', note: null, issuedBy: { id: 'u', name: 'Karim' },
    createdAt: new Date('2026-11-03T08:00:00Z'), finalizedAt: new Date('2026-11-03T09:00:00Z'), voided: null, lineCount: 1,
    lines: [{ lineNo: 1, sku: { id: 's', code: 'X-1' }, description: 'Dress, M, Black', quantity: 4, unitPrice: '25.00', discount: '0.00', lineTotal: '100.00' }], payments: [], ...patch,
});

describe('renderInvoicePdf', () => {
    it('makes a PDF for a final, a draft, a void and a sale invoice, with Arabic names, long lists and no customer', async () => {
        const many = Array.from({ length: 60 }, (_, i) => ({ lineNo: i + 1, sku: { id: `s${i}`, code: `CODE-${i}` }, description: `Product number ${i} with a quite long description to check that it fits the column`, quantity: 1, unitPrice: '1.00', discount: '0.00', lineTotal: '1.00' }));
        const cases: InvoiceView[] = [
            invoice(),
            invoice({ status: 'draft', reference: null, finalizedAt: null }),
            invoice({ status: 'void', voided: { at: new Date('2026-11-03T10:00:00Z'), by: { id: 'u', name: 'Karim' }, reason: 'Wrong price' } }),
            invoice({ kind: 'b2c', issuer: { id: 'h', name: 'Hamra' }, recipient: { branchId: null, name: 'رامي الخوري', phone: '+961 3 123 456' }, transfer: null, sale: { id: 's', reference: 'S-00000001' }, payments: [{ method: 'cash', amount: '60.00', reference: null }, { method: 'whish', amount: '40.00', reference: 'WH-1' }] }),
            invoice({ kind: 'b2c', recipient: { branchId: null, name: null, phone: null }, transfer: null, sale: { id: 's', reference: 'S-00000002' } }),
            invoice({ lines: many, lineCount: 60, subtotal: '60.00', total: '60.00' }),
        ];
        for (const c of cases) {
            const pdf = await renderInvoicePdf(c);
            expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
            expect(pdf.length).toBeGreaterThan(3000);
            expect(pdf.subarray(pdf.length - 8).toString()).toContain('%%EOF');
        }
    });
});
