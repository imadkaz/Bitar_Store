import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../utils/exeptions/ValidationError';
import { parseApproval, parseCreateReturn, parseHandback, parseRefundPayment, parseRejection, parseRelease, refundValueCents } from '../Return.model';

const sale = randomUUID(), branch = randomUUID(), sku = randomUUID();
const body = (patch: object = {}) => ({ saleId: sale, receivingBranchId: branch, reason: 'Does not fit', lines: [{ skuId: sku, quantity: 1, condition: 'as_new' }], ...patch });

describe('parseCreateReturn', () => {
    it('takes the sale, the branch, the products with their condition and the reason', () => {
        expect(parseCreateReturn(body({ note: '  tag still on ', custody: 'customer_keeps' }))).toEqual({ saleId: sale, receivingBranchId: branch, custody: 'customer_keeps', reason: 'Does not fit', note: 'tag still on', lateExceptionReason: null, lines: [{ skuId: sku, quantity: 1, condition: 'as_new' }] });
        expect(parseCreateReturn(body()).custody).toBe('with_branch');
        expect(parseCreateReturn(body({ lateException: { reason: 'Owner agreed by phone' } })).lateExceptionReason).toBe('Owner agreed by phone');
    });

    it('refuses what is wrong, clearly', () => {
        const other = randomUUID();
        const bad: object[] = [{ saleId: 'abc' }, { receivingBranchId: 5 }, { reason: 'ab' }, { reason: undefined }, { custody: 'somewhere' }, { lines: [] }, { lines: 'x' }, { lines: [{ skuId: 'abc', quantity: 1, condition: 'as_new' }] },
            { lines: [{ skuId: sku, quantity: 0, condition: 'as_new' }] }, { lines: [{ skuId: sku, quantity: 1.5, condition: 'as_new' }] }, { lines: [{ skuId: sku, quantity: 1, condition: 'perfect' }] }, { lines: [{ skuId: sku, quantity: 1 }] },
            { lines: [{ skuId: sku, quantity: 1, condition: 'as_new' }, { skuId: sku, quantity: 2, condition: 'damaged' }] }, { note: 'x'.repeat(201) }, { lateException: { reason: 'no' } }, { lateException: 'because' },
            { lines: Array.from({ length: 51 }, () => ({ skuId: randomUUID(), quantity: 1, condition: 'as_new' })) }, { lines: [{ skuId: other, quantity: 10_001, condition: 'as_new' }] }];
        for (const patch of bad) expect(() => parseCreateReturn(body(patch)), JSON.stringify(patch).slice(0, 80)).toThrow(ValidationError);
        for (const input of [undefined, null, 'x', [], 5]) expect(() => parseCreateReturn(input)).toThrow(ValidationError);
    });
});

describe('the decisions and the money', () => {
    it('a rejection needs a reason, a handback names who took the goods, an approval may carry a note', () => {
        expect(parseRejection({ reason: ' Worn and washed ' })).toEqual({ reason: 'Worn and washed' });
        expect(() => parseRejection({})).toThrow(ValidationError);
        expect(() => parseRejection({ reason: 'no' })).toThrow(ValidationError);
        expect(parseHandback({ recipient: ' Rami Khoury ' })).toEqual({ recipient: 'Rami Khoury' });
        expect(() => parseHandback({ recipient: 'R' })).toThrow(ValidationError);
        expect(parseApproval(undefined)).toEqual({ reason: null });
        expect(parseApproval({ reason: 'Defect confirmed' })).toEqual({ reason: 'Defect confirmed' });
    });

    it('the release takes everything on hold, or named lines with a quantity', () => {
        const line = randomUUID();
        expect(parseRelease(undefined)).toEqual({ lines: null });
        expect(parseRelease({})).toEqual({ lines: null });
        expect(parseRelease({ lines: [{ returnLineId: line, quantity: 2 }] })).toEqual({ lines: [{ returnLineId: line, quantity: 2 }] });
        for (const body of [{ lines: [] }, { lines: 'x' }, { lines: [{ returnLineId: 'abc', quantity: 1 }] }, { lines: [{ returnLineId: line, quantity: 0 }] }, { lines: [{ returnLineId: line, quantity: 1 }, { returnLineId: line, quantity: 1 }] }]) {
            expect(() => parseRelease(body), JSON.stringify(body)).toThrow(ValidationError);
        }
    });

    it('a refund payment is cash or Whish, an amount above zero, who receives it, and a reference only for Whish', () => {
        expect(parseRefundPayment({ method: 'cash', amount: '40.00', recipient: 'Rami Khoury' })).toEqual({ method: 'cash', amountCents: 4000, recipient: 'Rami Khoury', reference: null });
        expect(parseRefundPayment({ method: 'whish', amount: 12.5, recipient: 'Rami Khoury', reference: 'WH-1' }).reference).toBe('WH-1');
        for (const body of [{}, { method: 'card', amount: 1, recipient: 'Rami' }, { method: 'cash', recipient: 'Rami' }, { method: 'cash', amount: 0, recipient: 'Rami' }, { method: 'cash', amount: -5, recipient: 'Rami' },
            { method: 'cash', amount: 1.005, recipient: 'Rami' }, { method: 'cash', amount: 1 }, { method: 'cash', amount: 1, recipient: 'R' }, { method: 'cash', amount: 1, recipient: 'Rami', reference: 'WH-1' }, { method: 'whish', amount: 1, recipient: 'Rami', reference: 'x'.repeat(65) }]) {
            expect(() => parseRefundPayment(body), JSON.stringify(body)).toThrow(ValidationError);
        }
    });

    it('the refund is what was PAID for the units, in proportion, and the pieces add up to exactly the line total', () => {
        expect(refundValueCents(4000, 1, 0, 0, 1)).toBe(4000);                         // one unit paid 40.00
        expect(refundValueCents(9000, 3, 0, 0, 1)).toBe(3000);                         // 3 units paid 90.00: one is 30.00
        // 3 units paid 100.00 (so 33.33 each): returned one by one, the three refunds add up to 100.00 exactly
        const first = refundValueCents(10_000, 3, 0, 0, 1), second = refundValueCents(10_000, 3, 1, first, 1), third = refundValueCents(10_000, 3, 2, first + second, 1);
        expect([first, second, third]).toEqual([3333, 3334, 3333]);
        expect(first + second + third).toBe(10_000);
        expect(refundValueCents(10_000, 3, 0, 0, 3)).toBe(10_000);                     // all together: the same total
        expect(refundValueCents(0, 2, 0, 0, 1)).toBe(0);                               // a free item refunds nothing
        expect(() => refundValueCents(10_000, 3, 2, 0, 2)).toThrow(ValidationError);   // more than were sold
        expect(() => refundValueCents(10_000, 3, 0, 0, 0)).toThrow(ValidationError);
    });
});
