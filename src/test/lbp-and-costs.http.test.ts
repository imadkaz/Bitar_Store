import 'dotenv/config';
import { vi } from 'vitest';

vi.hoisted(() => {
    process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123456';
    process.env.AUTH_MODE = 'jwt';
});

import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../app';
import { prisma } from '../db';
import { usdCentsToLbp } from '../models/Lbp';
import { UserRole } from '../models/User.model';
import { UserRepository } from '../repositories/UserRepository';
import { JwtTokenService } from '../services/JwtTokenService';
import { createUserWithPassword } from '../test-helpers/createUserWithPassword';
import { waitForDatabase } from '../test-helpers/waitForDatabase';

// Prices are in dollars; a customer may pay a part in pounds (LBP), and part of the change can go back in pounds. The cost of what is sold is kept on the day of the sale.
const disposable = process.env.TEST_DB_DISPOSABLE === '1';
const stamp = Date.now();
const short = String(stamp).slice(-8);
const tokens = new JwtTokenService(process.env.JWT_SECRET!);
const as = (id: string) => ({ Authorization: `Bearer ${tokens.sign(id)}` });
const key = () => `lc-${randomUUID()}`;
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Beirut' }).format(new Date());
let counter = 0;
let adminId = '', mgrId = '', staffId = '', warehouseId = '';

const setSettings = (body: object) => request(app).put('/settings').set(as(adminId)).send(body);
const newBranch = async (tag: string) => {
    const id = (await request(app).post('/branches').set(as(adminId)).send({ code: `L${tag.slice(0, 2)}${short}${++counter}`, name: `LBP ${tag} ${counter}` })).body.id as string;
    for (const user of [mgrId, staffId]) expect((await request(app).put(`/users/${user}/branches/${id}`).set(as(adminId))).status).toBe(204);
    return id;
};
const newSku = async (price: string, branchId: string, stockAtBranch = 100) => {
    const styleId = (await request(app).post('/styles').set(as(adminId)).send({ code: `LC${short}${++counter}`, name: `LBP Dress ${counter}` })).body.id;
    const sku = (await request(app).post('/skus').set(as(adminId)).send({ styleId, skuCode: `LC${short}-${counter}`, size: 'M', color: 'Grey', standardPrice: price })).body.id as string;
    expect((await request(app).post('/stock/opening').set(as(adminId)).set('Idempotency-Key', key()).send({ branchId, lines: [{ skuId: sku, quantity: stockAtBranch }] })).status).toBe(201);
    return sku;
};
const receiveAtWarehouse = async (skuId: string, quantity: number, unitCost: string) => {
    const res = await request(app).post('/goods-receipts').set(as(adminId)).set('Idempotency-Key', key()).send({ supplierName: `LBP Supplier ${short}`, lines: [{ skuId, quantity, unitCost }] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
};
const sell = (userId: string, branchId: string, skuId: string, quantity: number, payments: object[], k = key()) =>
    request(app).post('/sales').set(as(userId)).set('Idempotency-Key', k).send({ branchId, lines: [{ skuId, quantity }], payments });
const costOf = async (saleId: string) => (await prisma.$queryRaw<{ cost: string | null; source: string | null }[]>`
    SELECT c.unit_cost_snapshot::text AS cost, c.source FROM sale_line_costs c JOIN sale_lines l ON l.id = c.sale_line_id WHERE l.sale_id = ${saleId}::uuid`)[0];

describe('the pound arithmetic', () => {
    it('rounds to the nearest step, exactly, with no floating point', () => {
        const fx = { rate: 89_500, step: 1_000 };
        expect(usdCentsToLbp(5000, fx)).toBe(4_475_000);                // 50.00 USD: exact
        expect(usdCentsToLbp(337, fx)).toBe(302_000);                   // 3.37 USD = 301,615 -> 302,000
        expect(usdCentsToLbp(300, fx)).toBe(269_000);                   // 3.00 USD = 268,500: half goes up
        expect(usdCentsToLbp(337, { rate: 89_500, step: 5_000 })).toBe(300_000);
        expect(usdCentsToLbp(337, { rate: 89_500, step: 1 })).toBe(301_615);
        expect(usdCentsToLbp(1, fx)).toBe(1_000);                       // a cent is 895 pounds: the nearest step is 1,000
        expect(usdCentsToLbp(99_999_999_999, { rate: 10_000_000, step: 1_000 })).toBe(9_999_999_999_900_000);       // large numbers stay exact
    });
});

describe.skipIf(!disposable)('pounds and costs (real database)', () => {
    beforeAll(async () => {
        await waitForDatabase(prisma);
        const make = async (tag: string, role: UserRole) => (await createUserWithPassword(new UserRepository(prisma), { email: `${tag}-${stamp}@bitar.test`, password: 'Password#123', fullName: `Test ${tag}`, role }, null)).getId();
        adminId = await make('lcadmin', UserRole.ADMIN);
        mgrId = await make('lcmgr', UserRole.MANAGER);
        staffId = await make('lcstaff', UserRole.EMPLOYEE);
        const all = await request(app).get('/branches').set(as(adminId));
        warehouseId = all.body.find((b: { kind: string }) => b.kind === 'warehouse')?.id;
        if (!warehouseId) warehouseId = (await request(app).post('/branches').set(as(adminId)).send({ code: `LW${short}`, name: 'Main Warehouse (lbp test)', kind: 'warehouse' })).body.id;
        await request(app).patch(`/branches/${warehouseId}`).set(as(adminId)).send({ isActive: true });
        expect((await setSettings({ exchangeRateUsdLbp: 89_500, lbpRoundingStep: 1_000 })).status).toBe(200);
    }, 120_000);

    afterAll(async () => { await setSettings({ exchangeRateUsdLbp: null, lbpRoundingStep: 1_000 }); });

    describe('paying in pounds', () => {
        it('a sale of 200 dollars: 150 in dollars and 50 in pounds (4,475,000): one total, the split is kept, with the rate of the day', async () => {
            const b = await newBranch('split');
            const sku = await newSku('50.00', b);
            const res = await sell(staffId, b, sku, 4, [{ method: 'cash', amount: '150.00', tendered: '150.00' }, { method: 'cash', currency: 'LBP', amount: '50.00' }]);
            expect(res.status, JSON.stringify(res.body)).toBe(201);
            expect(res.body).toMatchObject({ total: '200.00', exchangeRate: 89_500, totalLbp: 17_900_000 });
            expect(res.body.payments[0]).toMatchObject({ currency: 'USD', amount: '150.00', lbpAmount: null, changeLbp: null });
            expect(res.body.payments[1]).toMatchObject({ method: 'cash', currency: 'LBP', amount: '50.00', lbpAmount: 4_475_000, exchangeRate: 89_500, tendered: '50.00', change: '0.00' });
            const reread = (await request(app).get(`/sales/${res.body.id}`).set(as(staffId))).body;
            expect(reread.payments.map((p: { currency: string; lbpAmount: number | null }) => [p.currency, p.lbpAmount])).toEqual([['USD', null], ['LBP', 4_475_000]]);
        });

        it('pounds are rounded to the nearest step the manager chose; the dollar amount stays exact', async () => {
            const b = await newBranch('round');
            const sku = await newSku('3.37', b);
            const pay = (step: number) => setSettings({ lbpRoundingStep: step }).then(() => sell(staffId, b, sku, 1, [{ method: 'cash', currency: 'LBP', amount: '3.37' }]));
            expect((await pay(1_000)).body.payments[0]).toMatchObject({ lbpAmount: 302_000, amount: '3.37' });
            expect((await pay(5_000)).body.payments[0].lbpAmount).toBe(300_000);
            expect((await pay(1)).body.payments[0].lbpAmount).toBe(301_615);
            await setSettings({ lbpRoundingStep: 1_000 });
        });

        it('the change can go back partly in pounds: 40 given for 17, 3 of the 23 back in pounds, 20 in dollars', async () => {
            const b = await newBranch('change');
            const sku = await newSku('17.00', b);
            const res = await sell(staffId, b, sku, 1, [{ method: 'cash', amount: '17.00', tendered: '40.00', changeLbp: '3.00' }]);
            expect(res.status, JSON.stringify(res.body)).toBe(201);
            expect(res.body.payments[0]).toMatchObject({ amount: '17.00', tendered: '40.00', change: '23.00', changeUsd: '20.00', changeLbpUsd: '3.00', changeLbp: 269_000, exchangeRate: 89_500 });
            const all = await sell(staffId, b, sku, 1, [{ method: 'cash', amount: '17.00', tendered: '20.00', changeLbp: '3.00' }]);
            expect(all.body.payments[0]).toMatchObject({ change: '3.00', changeUsd: '0.00', changeLbpUsd: '3.00', changeLbp: 269_000 });
            const plain = await sell(staffId, b, sku, 1, [{ method: 'cash', amount: '17.00', tendered: '20.00' }]);
            expect(plain.body.payments[0]).toMatchObject({ change: '3.00', changeUsd: '3.00', changeLbpUsd: null, changeLbp: null });
        });

        it('what is refused: pounds with no rate set, cash given for a pound payment, Whish in pounds, more change in pounds than there is, a bad currency; nothing is sold', async () => {
            const b = await newBranch('refuse');
            const sku = await newSku('50.00', b);
            const stock = async () => (await prisma.stockBalance.findFirst({ where: { branchId: b, skuId: sku, bucket: 'sellable' } }))!.quantity;
            const before = await stock();
            const bad: [object[], number][] = [
                [[{ method: 'cash', currency: 'LBP', amount: '50.00', tendered: '60.00' }], 400],
                [[{ method: 'cash', currency: 'LBP', amount: '50.00', changeLbp: '1.00' }], 400],
                [[{ method: 'whish', currency: 'LBP', amount: '50.00', reference: `LB-${stamp}-a` }], 400],
                [[{ method: 'whish', amount: '50.00', reference: `LB-${stamp}-b`, changeLbp: '1.00' }], 400],
                [[{ method: 'cash', amount: '50.00', tendered: '55.00', changeLbp: '5.01' }], 400],
                [[{ method: 'cash', amount: '50.00', tendered: '55.00', changeLbp: '-1.00' }], 400],
                [[{ method: 'cash', amount: '50.00', changeLbp: '1.00' }], 400],
                [[{ method: 'cash', currency: 'EUR', amount: '50.00' }], 400],
                [[{ method: 'cash', currency: 'LBP', amount: '30.00' }, { method: 'cash', amount: '10.00', tendered: '10.00' }], 400],        // 40 paid for 50
            ];
            for (const [payments, status] of bad) expect((await sell(staffId, b, sku, 1, payments)).status, JSON.stringify(payments)).toBe(status);
            await setSettings({ exchangeRateUsdLbp: null });
            try {
                const noRate = await sell(staffId, b, sku, 1, [{ method: 'cash', currency: 'LBP', amount: '50.00' }]);
                expect(noRate.status).toBe(409);
                expect(noRate.body.message).toMatch(/exchange rate/);
                expect((await sell(staffId, b, sku, 1, [{ method: 'cash', amount: '50.00', tendered: '60.00', changeLbp: '5.00' }])).status).toBe(409);
                const dollars = await sell(staffId, b, sku, 1, [{ method: 'cash', amount: '50.00', tendered: '50.00' }]);             // dollars never need a rate
                expect(dollars.status).toBe(201);
                expect(dollars.body).toMatchObject({ exchangeRate: null, totalLbp: null });
            } finally { await setSettings({ exchangeRateUsdLbp: 89_500 }); }
            expect(await stock()).toBe(before - 1);                                                                                  // only the dollar sale was made
        });

        it('a change of the rate later does not touch the sales already made; a retry is done once; the same key for another currency is refused', async () => {
            const b = await newBranch('rate');
            const sku = await newSku('10.00', b);
            const k = key();
            const body = [{ method: 'cash', currency: 'LBP', amount: '10.00' }];
            const first = await sell(staffId, b, sku, 1, body, k);
            const again = await sell(staffId, b, sku, 1, body, k);
            expect([first.status, again.status, again.headers['idempotent-replay'], again.body.id]).toEqual([201, 201, 'true', first.body.id]);
            expect((await sell(staffId, b, sku, 1, [{ method: 'cash', amount: '10.00', tendered: '10.00' }], k)).status).toBe(409);
            await setSettings({ exchangeRateUsdLbp: 100_000 });
            try {
                const old = (await request(app).get(`/sales/${first.body.id}`).set(as(staffId))).body;
                expect(old).toMatchObject({ exchangeRate: 89_500, totalLbp: 895_000 });
                expect(old.payments[0]).toMatchObject({ lbpAmount: 895_000, exchangeRate: 89_500 });
                const fresh = await sell(staffId, b, sku, 1, body);
                expect(fresh.body).toMatchObject({ exchangeRate: 100_000, totalLbp: 1_000_000 });
            } finally { await setSettings({ exchangeRateUsdLbp: 89_500 }); }
        });
    });

    describe('the drawer and the invoice', () => {
        it('the drawer has ONE total in dollars; it also says how many pounds came in and went out; the invoice of the sale shows the total in pounds and how it was paid', async () => {
            const b = await newBranch('drawer');
            const sku = await newSku('50.00', b);
            const sku17 = await newSku('17.00', b);
            const session = (await request(app).post('/cash-sessions').set(as(mgrId)).send({ branchId: b, openingCash: '0' })).body;
            const a = await sell(staffId, b, sku, 4, [{ method: 'cash', amount: '150.00', tendered: '150.00' }, { method: 'cash', currency: 'LBP', amount: '50.00' }]);
            await sell(staffId, b, sku17, 1, [{ method: 'cash', amount: '17.00', tendered: '40.00', changeLbp: '3.00' }]);
            const view = (await request(app).get(`/cash-sessions/${session.id}`).set(as(mgrId))).body;
            expect(view.totals).toMatchObject({ salesCount: 2, cashPayments: '217.00', paidInLbp: '50.00', lbpReceived: 4_475_000, lbpChangeGiven: 269_000, expectedCash: '217.00', whishPayments: '0.00' });
            const closed = await request(app).post(`/cash-sessions/${session.id}/close`).set(as(mgrId)).send({ countedCash: '217.00' });
            expect(closed.status, JSON.stringify(closed.body)).toBe(200);
            expect(closed.body.closing).toMatchObject({ expectedCash: '217.00', difference: '0.00' });
            const invoice = await request(app).post('/invoices').set(as(mgrId)).send({ saleId: a.body.id, customerName: 'Rami Khoury' });
            expect(invoice.status, JSON.stringify(invoice.body)).toBe(201);
            expect(invoice.body).toMatchObject({ total: '200.00', exchangeRate: 89_500, totalLbp: 17_900_000 });
            expect(invoice.body.payments.map((p: { currency: string; lbpAmount: number | null }) => [p.currency, p.lbpAmount])).toEqual([['USD', null], ['LBP', 4_475_000]]);
            const pdf = await request(app).get(`/invoices/${invoice.body.id}/pdf`).set(as(mgrId)).buffer(true).parse((res, cb) => { const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); });
            expect(pdf.status).toBe(200);
            expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
            await setSettings({ exchangeRateUsdLbp: 120_000 });
            try { expect((await request(app).get(`/invoices/${invoice.body.id}`).set(as(mgrId))).body).toMatchObject({ exchangeRate: 89_500, totalLbp: 17_900_000 }); }      // the invoice keeps the rate of its sale
            finally { await setSettings({ exchangeRateUsdLbp: 89_500 }); }
        });
    });

    describe('the cost of what is sold is kept on the day of the sale', () => {
        it('the average cost at the warehouse is kept; when it changes later the sales already made keep theirs', async () => {
            const b = await newBranch('cost');
            const sku = await newSku('50.00', b);
            await receiveAtWarehouse(sku, 10, '12.00');
            const first = await sell(staffId, b, sku, 1, [{ method: 'cash', amount: '50.00', tendered: '50.00' }]);
            expect(await costOf(first.body.id)).toEqual({ cost: '12.0000', source: 'warehouse' });
            await receiveAtWarehouse(sku, 10, '32.00');                                          // the average is now 22.00
            const second = await sell(staffId, b, sku, 1, [{ method: 'cash', amount: '50.00', tendered: '50.00' }]);
            expect(await costOf(second.body.id)).toEqual({ cost: '22.0000', source: 'warehouse' });
            expect(await costOf(first.body.id)).toEqual({ cost: '12.0000', source: 'warehouse' });          // unchanged
            await expect(prisma.$executeRaw`UPDATE sale_line_costs SET unit_cost_snapshot = 1 WHERE sale_line_id IN (SELECT id FROM sale_lines WHERE sale_id = ${first.body.id}::uuid)`).rejects.toThrow();
        });

        it('with no warehouse cost the catalog cost a manager typed is used; with none at all the cost stays unknown (never zero)', async () => {
            const b = await newBranch('cost2');
            const withCatalog = await newSku('50.00', b);
            const nothing = await newSku('50.00', b);
            expect((await request(app).put(`/costs/skus/${withCatalog}`).set(as(mgrId)).send({ unitCost: '7.50' })).status).toBe(200);
            const a = await sell(staffId, b, withCatalog, 1, [{ method: 'cash', amount: '50.00', tendered: '50.00' }]);
            const n = await sell(staffId, b, nothing, 1, [{ method: 'cash', amount: '50.00', tendered: '50.00' }]);
            expect(await costOf(a.body.id)).toEqual({ cost: '7.5000', source: 'catalog' });
            expect(await costOf(n.body.id)).toEqual({ cost: null, source: null });
        });

        it('only a manager sets or sees a cost; bad values are a 400; null clears it; it is audited; the answer shows both costs', async () => {
            const b = await newBranch('cost3');
            const sku = await newSku('50.00', b);
            expect((await request(app).put(`/costs/skus/${sku}`).set(as(staffId)).send({ unitCost: '5.00' })).status).toBe(403);
            expect((await request(app).get(`/costs/skus/${sku}`).set(as(staffId))).status).toBe(403);
            expect((await request(app).get(`/costs/skus/${sku}`)).status).toBe(401);
            for (const body of [{}, { unitCost: 'abc' }, { unitCost: -1 }, { unitCost: '1.005' }, { unitCost: 100_000.01 }, [], 'x']) expect((await request(app).put(`/costs/skus/${sku}`).set(as(mgrId)).send(body as object)).status, JSON.stringify(body)).toBe(400);
            expect((await request(app).put(`/costs/skus/${randomUUID()}`).set(as(mgrId)).send({ unitCost: 1 })).status).toBe(404);
            expect((await request(app).get('/costs/skus/abc').set(as(mgrId))).status).toBe(404);
            await receiveAtWarehouse(sku, 5, '10.00');
            const set = await request(app).put(`/costs/skus/${sku}`).set(as(mgrId)).send({ unitCost: 9.5 });
            expect(set.body).toMatchObject({ skuId: sku, catalogCost: '9.5000', warehouseAverageCost: '10.0000' });
            const cleared = await request(app).put(`/costs/skus/${sku}`).set(as(adminId)).send({ unitCost: null });
            expect(cleared.body.catalogCost).toBeNull();
            const audit = await request(app).get(`/audit-events?entityType=sku&entityId=${sku}`).set(as(adminId));
            expect(audit.body.filter((e: { action: string }) => e.action === 'sku.cost_set').map((e: { details: { before: string | null; after: string | null } }) => [e.details.before, e.details.after])).toEqual(expect.arrayContaining([[null, '9.5000'], ['9.5000', null]]));
        });

        it('a supply invoice takes the catalog cost when the warehouse has no cost yet (opening stock), so its line is no longer missing', async () => {
            const b = await newBranch('cost4');
            const sku = await newSku('50.00', warehouseId, 20);
            await request(app).put(`/costs/skus/${sku}`).set(as(mgrId)).send({ unitCost: '9.00' });
            const t = (await request(app).post('/transfers').set(as(adminId)).set('Idempotency-Key', key()).send({ sourceBranchId: warehouseId, destinationBranchId: b, lines: [{ skuId: sku, quantity: 3 }] })).body;
            expect((await request(app).post(`/transfers/${t.id}/dispatch`).set(as(adminId)).set('Idempotency-Key', key())).status).toBe(200);
            const found = (await request(app).get(`/invoices?transferId=${t.id}`).set(as(adminId))).body;
            const detail = (await request(app).get(`/invoices/${found[0].id}`).set(as(adminId))).body;
            expect(detail.lines[0]).toMatchObject({ unitPrice: '9.00', lineTotal: '27.00', priceSource: 'cost' });
        });
    });

    describe('the profit report: what was sold minus what it cost, on the cost of the day', () => {
        it('revenue, cost and profit per branch and in total; sales of unknown cost are shown apart, never guessed', async () => {
            const b = await newBranch('profit');
            const known = await newSku('50.00', b), catalog = await newSku('50.00', b), unknown = await newSku('50.00', b);
            await receiveAtWarehouse(known, 10, '12.00');
            await request(app).put(`/costs/skus/${catalog}`).set(as(mgrId)).send({ unitCost: '7.50' });
            await sell(staffId, b, known, 2, [{ method: 'cash', amount: '100.00', tendered: '100.00' }]);       // 100 for 24
            await sell(staffId, b, catalog, 1, [{ method: 'cash', amount: '50.00', tendered: '50.00' }]);       // 50 for 7.50
            await sell(staffId, b, unknown, 1, [{ method: 'cash', amount: '50.00', tendered: '50.00' }]);       // 50, cost unknown
            const res = await request(app).get(`/costs/profit?branchId=${b}&from=${today}&to=${today}`).set(as(mgrId));
            expect(res.status, JSON.stringify(res.body)).toBe(200);
            expect(res.body.byBranch).toEqual([{ branchId: b, revenue: '200.00', cost: '31.50', profit: '118.50', unknownCostRevenue: '50.00', salesCount: 3, refunds: '0.00', returnedCost: '0.00', netRevenue: '200.00', netProfit: '118.50' }]);      // 150 known - 31.50
            expect(res.body.totals).toEqual({ revenue: '200.00', cost: '31.50', profit: '118.50', unknownCostRevenue: '50.00', salesCount: 3, refunds: '0.00', returnedCost: '0.00', netRevenue: '200.00', netProfit: '118.50' });
            const empty = await newBranch('profit2');
            const none = await request(app).get(`/costs/profit?branchId=${empty}&from=${today}&to=${today}`).set(as(mgrId));
            expect(none.body.totals).toEqual({ revenue: '0.00', cost: '0.00', profit: '0.00', unknownCostRevenue: '0.00', salesCount: 0, refunds: '0.00', returnedCost: '0.00', netRevenue: '0.00', netProfit: '0.00' });
        });

        it('only an admin or a manager; a branch you do not reach is refused; a bad period is a 400', async () => {
            const b = await newBranch('profit3');
            expect((await request(app).get(`/costs/profit?branchId=${b}`).set(as(staffId))).status).toBe(403);
            expect((await request(app).get(`/costs/profit?branchId=${b}`)).status).toBe(401);
            const elsewhere = (await request(app).post('/branches').set(as(adminId)).send({ code: `LE${short}${++counter}`, name: 'Not yours' })).body.id;
            expect((await request(app).get(`/costs/profit?branchId=${elsewhere}`).set(as(mgrId))).status).toBeGreaterThanOrEqual(403);
            for (const q of ['from=2026-13-01', 'from=2026-11-05&to=2026-11-01', 'branchId=abc']) expect((await request(app).get(`/costs/profit?${q}`).set(as(adminId))).status, q).toBe(400);
        });
    });
});
