import { describe, expect, it } from 'vitest';
import { BUSINESS_TIME_ZONE, businessDateOf, isRealDate } from '../../utils/businessDate';
import { ValidationError } from '../../utils/exeptions/ValidationError';
import { Sale } from '../Sale.model';
import { PaymentInput } from '../SalePayment.model';
import { SaleLine} from '../SaleLine.model';
import { SalePayment } from '../SalePayment.model';


const SELLER = 'seller-1';
const MANAGER = 'manager-1';
const base = (patch: Record<string, unknown> = {}) => ({
    id: 's1', branchId: 'b1', soldBy: SELLER, currency: 'USD', businessDate: '2026-10-27',
    lines: [{ skuId: 'k1', quantity: 1, unitPriceStandardCents: 4500 }],
    payments: [{ method: 'cash', amountCents: 4500 }] as PaymentInput[],
    ...patch,
});

describe('SaleLine: prices and discounts in whole cents', () => {
    it('line total = unit price x quantity, with no rounding trouble', () => {
        const line = SaleLine.create(1, { skuId: 'k', quantity: 3, unitPriceStandardCents: 999 });
        expect([line.lineStandardTotalCents, line.lineTotalCents, line.getDiscountCents()]).toEqual([2997, 2997, 0]);
    });

    it('a percentage discount rounds half UP to the cent', () => {
        const total = (unit: number, qty: number, hundredths: number) =>
            SaleLine.create(1, { skuId: 'k', quantity: qty, unitPriceStandardCents: unit, reduction: { type: 'percent', percentHundredths: hundredths, reason: 'friend', approvedBy: MANAGER } }).lineTotalCents;
        expect(total(1001, 1, 5000)).toBe(501);       // 50 % of 10.01 = 5.005 -> 5.01
        expect(total(999, 1, 1000)).toBe(899);        // 10 % of 9.99 = 8.991 -> 8.99
        expect(total(1000, 1, 3333)).toBe(667);       // 33.33 % off 10.00 = 6.667 -> 6.67
        expect(total(2997, 1, 1500)).toBe(2547);      // 15 % off 29.97 = 25.4745 -> 25.47
        expect(total(100_000, 1, 1)).toBe(99_990);    // 0.01 % off 1000.00
        expect(total(4500, 2, 10_000)).toBe(0);       // 100 % off is free
    });

    it('a price override replaces the unit price and can never be above the catalog price', () => {
        const make = (unitPriceCents: number) =>
            SaleLine.create(1, { skuId: 'k', quantity: 2, unitPriceStandardCents: 4500, reduction: { type: 'override', unitPriceCents, reason: 'damaged', approvedBy: MANAGER } });
        expect(make(4000).lineTotalCents).toBe(8000);
        expect(make(4000).getDiscountCents()).toBe(1000);
        expect(make(0).lineTotalCents).toBe(0);
        expect(make(4500).lineTotalCents).toBe(9000);
        expect(() => make(4501)).toThrow(ValidationError);
        expect(() => make(-1)).toThrow(ValidationError);
        expect(() => make(1.5)).toThrow(ValidationError);
    });

    it('every discount needs a reason and a valid size', () => {
        const percent = (hundredths: number, reason: unknown) => () =>
            SaleLine.create(1, { skuId: 'k', quantity: 1, unitPriceStandardCents: 4500, reduction: { type: 'percent', percentHundredths: hundredths, reason: reason as string, approvedBy: MANAGER } });
        expect(percent(1000, 'holiday')).not.toThrow();
        for (const bad of [undefined, '', '   ', 5, 'x'.repeat(201)]) expect(percent(1000, bad), String(bad)).toThrow(ValidationError);
        for (const bad of [0, -5, 10_001, 12.5]) expect(percent(bad, 'ok'), String(bad)).toThrow(ValidationError);
    });

    it('quantity must be a whole number from 1 to 10000, and a line cannot overflow the database', () => {
        const make = (quantity: number, unit = 100) => () => SaleLine.create(1, { skuId: 'k', quantity, unitPriceStandardCents: unit });
        expect(make(1)).not.toThrow();
        expect(make(10_000)).not.toThrow();
        for (const bad of [0, -1, 1.5, 10_001, NaN]) expect(make(bad), String(bad)).toThrow(ValidationError);
        expect(make(10_000, 999_999_999_999)).toThrow(ValidationError);
    });
});

describe('SalePayment', () => {
    it('cash: the amount paid, the cash handed over, and the change', () => {
        const exact = SalePayment.create({ method: 'cash', amountCents: 2000 }, SELLER);
        expect([exact.tenderedCents, exact.getChangeCents()]).toEqual([2000, 0]);
        const change = SalePayment.create({ method: 'cash', amountCents: 2000, tenderedCents: 5000 }, SELLER);
        expect(change.getChangeCents()).toBe(3000);
        expect(() => SalePayment.create({ method: 'cash', amountCents: 2000, tenderedCents: 1999 }, SELLER)).toThrow(ValidationError);
    });

    it('whish: needs the verified transfer reference, trimmed and visible characters only', () => {
        expect(SalePayment.create({ method: 'whish', amountCents: 2500, whishReference: '  WH-123456 ' }, SELLER).whishReference).toBe('WH-123456');
        for (const bad of [undefined, '', '   ', 'has space', 'x'.repeat(65), 'ü']) {
            expect(() => SalePayment.create({ method: 'whish', amountCents: 2500, whishReference: bad as string }, SELLER), String(bad)).toThrow(ValidationError);
        }
    });

    it('refuses mixed-up fields, empty amounts and unknown methods', () => {
        expect(() => SalePayment.create({ method: 'whish', amountCents: 100, whishReference: 'A1', tenderedCents: 100 }, SELLER)).toThrow(ValidationError);
        expect(() => SalePayment.create({ method: 'cash', amountCents: 100, whishReference: 'A1' }, SELLER)).toThrow(ValidationError);
        for (const amountCents of [0, -5, 1.5]) expect(() => SalePayment.create({ method: 'cash', amountCents }, SELLER)).toThrow(ValidationError);
        expect(() => SalePayment.create({ method: 'card' as never, amountCents: 100 }, SELLER)).toThrow(ValidationError);
    });
});

describe('Sale: completed means fully paid', () => {
    it('the worked example of BL-04: 1 dress at 45.00 paid 20.00 cash + 25.00 Whish', () => {
        const sale = Sale.create(base({ payments: [{ method: 'cash', amountCents: 2000, tenderedCents: 5000 }, { method: 'whish', amountCents: 2500, whishReference: 'WH-1' }] }));
        expect([sale.subtotalCents, sale.discountCents, sale.totalCents]).toEqual([4500, 0, 4500]);
        expect(sale.payments.map((p) => p.amountCents)).toEqual([2000, 2500]);
        expect(sale.payments[0].getChangeCents()).toBe(3000);
    });

    it('totals add up across lines and discounts', () => {
        const sale = Sale.create(base({
            lines: [
                { skuId: 'k1', quantity: 2, unitPriceStandardCents: 4500 },
                { skuId: 'k2', quantity: 1, unitPriceStandardCents: 1200, reduction: { type: 'percent', percentHundredths: 2500, reason: 'event', approvedBy: MANAGER } },
            ],
            payments: [{ method: 'cash', amountCents: 9900 }],
        }));
        expect([sale.subtotalCents, sale.totalCents, sale.discountCents]).toEqual([10_200, 9900, 300]);
        expect(sale.lines.map((l) => l.lineNo)).toEqual([1, 2]);
    });

    it('refuses payments that are short or too much, to the cent', () => {
        const pay = (...amounts: number[]) => () => Sale.create(base({ payments: amounts.map((amountCents) => ({ method: 'cash', amountCents })) }));
        expect(pay(4500)).not.toThrow();
        expect(pay(2000, 2500)).not.toThrow();
        expect(pay(4499)).toThrow('The payments add up to 44.99 but the sale total is 45.00');
        expect(pay(4501)).toThrow(ValidationError);
        expect(pay(2000, 2000)).toThrow(ValidationError);
        expect(() => Sale.create(base({ payments: [] }))).toThrow(ValidationError);
    });

    it('a free sale (total 0) has no payments', () => {
        const free = (payments: PaymentInput[]) => () =>
            Sale.create(base({ lines: [{ skuId: 'k1', quantity: 1, unitPriceStandardCents: 4500, reduction: { type: 'percent', percentHundredths: 10_000, reason: 'gift', approvedBy: MANAGER } }], payments }));
        expect(free([])).not.toThrow();
        expect(free([{ method: 'cash', amountCents: 100 }])).toThrow(ValidationError);
    });

    it('lines: at least 1, at most 50, and each sku once', () => {
        const lines = (n: number) => Array.from({ length: n }, (_, i) => ({ skuId: `k${i}`, quantity: 1, unitPriceStandardCents: 100 }));
        expect(() => Sale.create(base({ lines: [] }))).toThrow(ValidationError);
        expect(() => Sale.create(base({ lines: lines(50), payments: [{ method: 'cash', amountCents: 5000 }] }))).not.toThrow();
        expect(() => Sale.create(base({ lines: lines(51), payments: [{ method: 'cash', amountCents: 5100 }] }))).toThrow(ValidationError);
        expect(() => Sale.create(base({ lines: [lines(1)[0], lines(1)[0]], payments: [{ method: 'cash', amountCents: 200 }] }))).toThrow('Each sku can appear only once');
    });

    it('at most 4 payments', () => {
        const five = Array.from({ length: 5 }, () => ({ method: 'cash' as const, amountCents: 900 }));
        expect(() => Sale.create(base({ lines: [{ skuId: 'k1', quantity: 1, unitPriceStandardCents: 4500 }], payments: five }))).toThrow(ValidationError);
    });

    it('channel: in store by default; social media needs its platform; the platform is only for social media', () => {
        expect(Sale.create(base()).channel).toBe('in_store');
        expect(Sale.create(base({ channel: 'social_media', socialPlatform: 'facebook' })).socialPlatform).toBe('facebook');
        expect(() => Sale.create(base({ channel: 'social_media' }))).toThrow(ValidationError);
        expect(() => Sale.create(base({ channel: 'social_media', socialPlatform: 'myspace' }))).toThrow(ValidationError);
        expect(() => Sale.create(base({ socialPlatform: 'facebook' }))).toThrow(ValidationError);
        expect(() => Sale.create(base({ channel: 'online' }))).toThrow(ValidationError);
    });

    it('the note is trimmed, empty means none, and it is limited', () => {
        expect(Sale.create(base({ note: '  gift wrap ' })).note).toBe('gift wrap');
        expect(Sale.create(base({ note: '   ' })).note).toBeNull();
        expect(() => Sale.create(base({ note: 'x'.repeat(501) }))).toThrow(ValidationError);
        expect(() => Sale.create(base({ note: 5 }))).toThrow(ValidationError);
    });
});

describe('the shop day', () => {
    it('is the Lebanese day, not the UTC day', () => {
        expect(BUSINESS_TIME_ZONE).toBe('Asia/Beirut');
        expect(businessDateOf(new Date('2026-01-15T21:30:00Z'))).toBe('2026-01-15');   // 23:30 in Beirut (winter: UTC+2)
        expect(businessDateOf(new Date('2026-01-15T22:30:00Z'))).toBe('2026-01-16');   // 00:30 in Beirut: already the next day
        expect(businessDateOf(new Date('2026-07-15T21:30:00Z'))).toBe('2026-07-16');   // 00:30 in Beirut (summer: UTC+3)
    });

    it('recognises real dates only', () => {
        for (const ok of ['2026-10-27', '2024-02-29']) expect(isRealDate(ok)).toBe(true);
        for (const bad of ['2026-02-30', '2026-13-01', '2026-1-5', '27-10-2026', '', 'today']) expect(isRealDate(bad), bad).toBe(false);
    });
});
