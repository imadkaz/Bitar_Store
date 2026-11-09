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
import { UserRole } from '../models/User.model';
import { UserRepository } from '../repositories/UserRepository';
import { JwtTokenService } from '../services/JwtTokenService';
import { createUserWithPassword } from '../test-helpers/createUserWithPassword';
import { waitForDatabase } from '../test-helpers/waitForDatabase';

// Customer returns (approved BL-04): custody first, a manager decides, the goods enter the hold once, release and refund are separate events.
const disposable = process.env.TEST_DB_DISPOSABLE === '1';
const stamp = Date.now();
const short = String(stamp).slice(-8);
const tokens = new JwtTokenService(process.env.JWT_SECRET!);
const as = (id: string) => ({ Authorization: `Bearer ${tokens.sign(id)}` });
const key = () => `rt-${randomUUID()}`;
let counter = 0;
let adminId = '', mgrId = '', clerkId = '', plainId = '', strangerId = '';

const setSettings = (body: object) => request(app).put('/settings').set(as(adminId)).send(body);
const newBranch = async (tag: string) => {
    const id = (await request(app).post('/branches').set(as(adminId)).send({ code: `R${tag.slice(0, 2)}${short}${++counter}`, name: `Returns ${tag} ${counter}` })).body.id as string;
    for (const user of [mgrId, clerkId, plainId]) expect((await request(app).put(`/users/${user}/branches/${id}`).set(as(adminId))).status).toBe(204);
    return id;
};
const newSku = async (branchId: string, stock = 50, price = '40.00') => {
    const styleId = (await request(app).post('/styles').set(as(adminId)).send({ code: `RT${short}${++counter}`, name: `Return Dress ${counter}` })).body.id;
    const sku = (await request(app).post('/skus').set(as(adminId)).send({ styleId, skuCode: `RT${short}-${counter}`, size: 'M', color: 'Grey', standardPrice: price })).body.id as string;
    expect((await request(app).post('/stock/opening').set(as(adminId)).set('Idempotency-Key', key()).send({ branchId, lines: [{ skuId: sku, quantity: stock }] })).status).toBe(201);
    return sku;
};
const sell = async (branchId: string, skuId: string, quantity: number, total: string, discount?: object) => {
    const res = await request(app).post('/sales').set(as(mgrId)).set('Idempotency-Key', key()).send({ branchId, lines: [{ skuId, quantity, ...(discount ? { discount } : {}) }], payments: [{ method: 'cash', amount: total, tendered: total }] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; reference: string };
};
const receive = (userId: string, saleId: string, branchId: string, skuId: string, quantity: number, extra: object = {}, k = key()) =>
    request(app).post('/returns').set(as(userId)).set('Idempotency-Key', k).send({ saleId, receivingBranchId: branchId, reason: 'Does not fit', lines: [{ skuId, quantity, condition: 'as_new' }], ...extra });
const approve = (userId: string, id: string, k = key()) => request(app).post(`/returns/${id}/approve`).set(as(userId)).set('Idempotency-Key', k).send({});
const release = (userId: string, id: string, body: object = {}, k = key()) => request(app).post(`/returns/${id}/release`).set(as(userId)).set('Idempotency-Key', k).send(body);
const refund = (userId: string, id: string, body: object, k = key()) => request(app).post(`/returns/${id}/refunds`).set(as(userId)).set('Idempotency-Key', k).send(body);
const qty = async (branchId: string, skuId: string, bucket: string) => (await prisma.stockBalance.findFirst({ where: { branchId, skuId, bucket } }))?.quantity ?? 0;
const get = async (userId: string, id: string) => (await request(app).get(`/returns/${id}`).set(as(userId))).body;

describe.skipIf(!disposable)('customer returns (real database)', () => {
    beforeAll(async () => {
        await waitForDatabase(prisma);
        const make = async (tag: string, role: UserRole) => (await createUserWithPassword(new UserRepository(prisma), { email: `${tag}-${stamp}@bitar.test`, password: 'Password#123', fullName: `Test ${tag}`, role }, null)).getId();
        adminId = await make('rtadmin', UserRole.ADMIN);
        mgrId = await make('rtmgr', UserRole.MANAGER);
        clerkId = await make('rtclerk', UserRole.EMPLOYEE);
        plainId = await make('rtplain', UserRole.EMPLOYEE);
        strangerId = await make('rtstranger', UserRole.MANAGER);
        expect((await request(app).put(`/users/${clerkId}/permissions`).set(as(adminId)).send({ permissions: { 'returns.create': true } })).status).toBeLessThan(300);
        expect((await setSettings({ returnPeriodDays: 14, requireOpenCashSession: false })).status).toBe(200);
    }, 120_000);

    afterAll(async () => { await setSettings({ returnPeriodDays: 14, requireOpenCashSession: false }); });

    describe('finding the sale, at any branch', () => {
        it('the sale is found by its number or its id, wherever it was made, with what can still be returned', async () => {
            const a = await newBranch('find'), skuA = await newSku(a);
            const sale = await sell(a, skuA, 3, '120.00');
            for (const k of [sale.reference, sale.reference.toLowerCase(), sale.id]) {
                const res = await request(app).get(`/returns/eligible?sale=${k}`).set(as(clerkId));
                expect(res.status, k).toBe(200);
                expect(res.body).toMatchObject({ sale: { id: sale.id, reference: sale.reference, branch: { id: a }, total: '120.00' }, returnPeriodDays: 14, daysSinceSale: 0, withinPeriod: true });
                expect(res.body.lines).toEqual([expect.objectContaining({ skuId: skuA, sold: 3, returned: 0, inCustody: 0, returnable: 3, lineTotal: '120.00' })]);
            }
            expect((await request(app).get('/returns/eligible?sale=S-99999999').set(as(clerkId))).status).toBe(404);
            expect((await request(app).get('/returns/eligible').set(as(clerkId))).status).toBe(400);
            expect((await request(app).get('/returns/eligible?sale=x').set(as(clerkId))).status).toBe(400);
            expect((await request(app).get(`/returns/eligible?sale=${sale.reference}`).set(as(plainId))).status).toBe(403);
            expect((await request(app).get(`/returns/eligible?sale=${sale.reference}`)).status).toBe(401);
        });
    });

    describe('receiving the goods: custody, not stock', () => {
        it('a return at ANOTHER branch is linked to the sale and changes no stock: the goods are the customer\'s until a manager decides', async () => {
            const a = await newBranch('src'), b = await newBranch('recv'), sku = await newSku(a);
            const sale = await sell(a, sku, 3, '120.00');
            const before = [await qty(a, sku, 'sellable'), await qty(b, sku, 'sellable'), await qty(b, sku, 'non_sellable')];
            const k = key();
            const res = await receive(clerkId, sale.id, b, sku, 1, { note: 'Tag still on' }, k);
            expect(res.status, JSON.stringify(res.body)).toBe(201);
            expect(res.body).toMatchObject({ status: 'in_custody', custody: 'with_branch', reason: 'Does not fit', note: 'Tag still on', refund: null, decision: null, handback: null,
                sale: { id: sale.id, branch: { id: a } }, receivingBranch: { id: b }, receivedBy: { id: clerkId } });
            expect(res.body.reference).toMatch(/^RET-\d{8}$/);
            expect(res.body.lines).toEqual([expect.objectContaining({ quantity: 1, condition: 'as_new', refundValue: null, releasedQty: 0, onHold: 0, sku: expect.objectContaining({ id: sku }) })]);
            expect([await qty(a, sku, 'sellable'), await qty(b, sku, 'sellable'), await qty(b, sku, 'non_sellable')]).toEqual(before);          // nothing moved
            const again = await receive(clerkId, sale.id, b, sku, 1, { note: 'Tag still on' }, k);
            expect([again.status, again.headers['idempotent-replay'], again.body.id]).toEqual([201, 'true', res.body.id]);
            expect((await receive(clerkId, sale.id, b, sku, 2, {}, k)).status).toBe(409);                                                          // same key, another request
            const check = (await request(app).get(`/returns/eligible?sale=${sale.id}`).set(as(clerkId))).body;
            expect(check.lines[0]).toMatchObject({ returned: 0, inCustody: 1, returnable: 2 });                                                    // the custody already counts toward the limit
        });

        it('never more than was sold less what is already returned or in custody; a rejected return frees its units', async () => {
            const a = await newBranch('limit'), sku = await newSku(a);
            const sale = await sell(a, sku, 3, '120.00');
            const first = await receive(clerkId, sale.id, a, sku, 2);
            expect(first.status).toBe(201);
            const tooMany = await receive(clerkId, sale.id, a, sku, 2);
            expect(tooMany.status).toBe(409);
            expect(tooMany.body.message).toMatch(/asked 2, returnable 1/);
            expect((await receive(clerkId, sale.id, a, sku, 1)).status).toBe(201);                                                                 // the last one
            expect((await receive(clerkId, sale.id, a, sku, 1)).status).toBe(409);                                                                 // nothing left
            expect((await request(app).post(`/returns/${first.body.id}/reject`).set(as(mgrId)).send({ reason: 'Worn and washed' })).status).toBe(200);
            expect((await receive(clerkId, sale.id, a, sku, 2)).status).toBe(201);                                                                 // the rejected units can be returned again
        });

        it('what is refused: a product not on the sale, the warehouse, an unreachable branch, no right, a bad body; and 4 at the same moment for the last unit: exactly one', async () => {
            const a = await newBranch('bad'), sku = await newSku(a), other = await newSku(a);
            const sale = await sell(a, sku, 1, '40.00');
            expect((await receive(clerkId, sale.id, a, other, 1)).status).toBe(404);
            const wh = (await request(app).get('/branches').set(as(adminId))).body.find((x: { kind: string }) => x.kind === 'warehouse')?.id
                ?? (await request(app).post('/branches').set(as(adminId)).send({ code: `RW${short}`, name: 'Main Warehouse (returns test)', kind: 'warehouse' })).body.id;
            await request(app).patch(`/branches/${wh}`).set(as(adminId)).send({ isActive: true });
            const atWarehouse = await receive(adminId, sale.id, wh, sku, 1);
            expect(atWarehouse.status).toBe(409);
            expect(atWarehouse.body.message).toMatch(/not at the warehouse/);
            expect((await receive(strangerId, sale.id, a, sku, 1)).status).toBe(404);                                                              // a manager who does not reach the branch: it does not exist for them
            expect((await receive(plainId, sale.id, a, sku, 1)).status).toBe(403);
            const elsewhere = (await request(app).post('/branches').set(as(adminId)).send({ code: `RE${short}${++counter}`, name: 'Not yours' })).body.id;
            expect((await receive(clerkId, sale.id, elsewhere, sku, 1)).status).toBe(404);                                                         // nor a branch the clerk does not reach
            expect((await request(app).post('/returns').set(as(clerkId)).send({ saleId: sale.id, receivingBranchId: a, reason: 'x', lines: [] })).status).toBe(400);
            expect((await request(app).post('/returns').set(as(clerkId)).set('Idempotency-Key', key()).send({ saleId: randomUUID(), receivingBranchId: a, reason: 'Does not fit', lines: [{ skuId: sku, quantity: 1, condition: 'as_new' }] })).status).toBe(404);
            const racing = await Promise.all([clerkId, mgrId, clerkId, mgrId].map((u) => receive(u, sale.id, a, sku, 1)));
            expect(racing.filter((r) => r.status === 201)).toHaveLength(1);
            expect(racing.filter((r) => r.status === 409)).toHaveLength(3);
        });

        it('outside the return period only a manager\'s exception receives it, with a reason; the day count is the shop days', async () => {
            const a = await newBranch('late'), sku = await newSku(a);
            const sale = await sell(a, sku, 3, '120.00');
            await prisma.$executeRaw`UPDATE sales SET business_date = business_date - 20 WHERE id = ${sale.id}::uuid`;
            const info = (await request(app).get(`/returns/eligible?sale=${sale.id}`).set(as(clerkId))).body;
            expect(info).toMatchObject({ daysSinceSale: 20, returnPeriodDays: 14, withinPeriod: false });
            const refused = await receive(clerkId, sale.id, a, sku, 1);
            expect(refused.status).toBe(409);
            expect(refused.body.message).toMatch(/20 days old.*14 days.*exception/);
            expect((await receive(clerkId, sale.id, a, sku, 1, { lateException: { reason: 'The owner agreed' } })).status).toBe(403);              // an employee cannot grant it
            const ok = await receive(mgrId, sale.id, a, sku, 1, { lateException: { reason: 'The owner agreed by phone' } });
            expect(ok.status, JSON.stringify(ok.body)).toBe(201);
            expect(ok.body.lateExceptionReason).toBe('The owner agreed by phone');
            await setSettings({ returnPeriodDays: 30 });
            try { expect((await receive(clerkId, sale.id, a, sku, 1)).status).toBe(201); } finally { await setSettings({ returnPeriodDays: 14 }); }      // the manager set 30 days: inside the period
        });
    });

    describe('the manager decides: approval puts the goods on hold once and fixes the refund', () => {
        it('approved: the goods enter the hold at the RECEIVING branch once, the refund is what was PAID (after the discount), nothing is released for sale', async () => {
            const a = await newBranch('appr'), b = await newBranch('apprb'), sku = await newSku(a);
            const sale = await sell(a, sku, 3, '90.00', { type: 'percent', percent: '25', reason: 'Loyal customer' });                // 3 x 40 less 25% = 90.00: 30.00 a unit
            const r = (await receive(clerkId, sale.id, b, sku, 2)).body;
            const stockA = [await qty(a, sku, 'sellable'), await qty(a, sku, 'non_sellable')];
            expect((await approve(clerkId, r.id)).status).toBe(403);                                                                        // an employee, even with returns.create, cannot decide
            const k = key();
            const done = await approve(mgrId, r.id, k);
            expect(done.status, JSON.stringify(done.body)).toBe(200);
            expect(done.body).toMatchObject({ status: 'approved', decision: { by: { id: mgrId } }, refund: { total: '60.00', paid: '0.00', outstanding: '60.00', status: 'pending', payments: [] } });
            expect(done.body.lines[0]).toMatchObject({ refundValue: '60.00', releasedQty: 0, onHold: 2 });                                  // 2 x 30.00, not 2 x 40.00
            expect([await qty(b, sku, 'non_sellable'), await qty(b, sku, 'sellable')]).toEqual([2, 0]);                                     // on hold at B, not for sale
            expect([await qty(a, sku, 'sellable'), await qty(a, sku, 'non_sellable')]).toEqual(stockA);                                     // the selling branch is untouched
            const ledger = await prisma.$queryRaw<{ movement_type: string; bucket: string; quantity_delta: number; balance_after: number }[]>`SELECT movement_type, bucket, quantity_delta, balance_after FROM stock_movements WHERE return_id = ${r.id}::uuid`;
            expect(ledger).toEqual([{ movement_type: 'return_approval', bucket: 'non_sellable', quantity_delta: 2, balance_after: 2 }]);
            const replay = await approve(mgrId, r.id, k);
            expect([replay.status, replay.headers['idempotent-replay']]).toEqual([200, 'true']);
            expect(await qty(b, sku, 'non_sellable')).toBe(2);                                                                              // once
            expect((await approve(mgrId, r.id)).status).toBe(409);                                                                          // already approved
            expect((await request(app).post(`/returns/${r.id}/reject`).set(as(mgrId)).send({ reason: 'Changed my mind' })).status).toBe(409);
            const diffs = await prisma.$queryRaw<{ sku_id: string }[]>`SELECT sku_id FROM v_stock_reconciliation_diffs WHERE sku_id = ${sku}::uuid`;
            expect(diffs).toEqual([]);                                                                                                       // the books balance
        });

        it('several partial returns of one sale refund exactly what was paid, never more', async () => {
            const a = await newBranch('part'), sku = await newSku(a);
            const sale = await sell(a, sku, 3, '90.00', { type: 'percent', percent: '25', reason: 'Loyal customer' });
            const totals: string[] = [];
            for (let i = 0; i < 3; i++) {
                const r = (await receive(clerkId, sale.id, a, sku, 1)).body;
                const done = await approve(mgrId, r.id);
                expect(done.status, JSON.stringify(done.body)).toBe(200);
                totals.push(done.body.refund.total);
            }
            expect(totals).toEqual(['30.00', '30.00', '30.00']);                                                                            // 90.00 in all: the price paid, not the price today
            expect((await receive(clerkId, sale.id, a, sku, 1)).status).toBe(409);
            const check = (await request(app).get(`/returns/eligible?sale=${sale.id}`).set(as(clerkId))).body;
            expect(check.lines[0]).toMatchObject({ sold: 3, returned: 3, inCustody: 0, returnable: 0 });
        });

        it('the same approval 3 times at the same moment: the goods enter the hold once', async () => {
            const a = await newBranch('race'), sku = await newSku(a);
            const sale = await sell(a, sku, 2, '80.00');
            const r = (await receive(clerkId, sale.id, a, sku, 2)).body;
            const results = await Promise.all([1, 2, 3].map(() => approve(mgrId, r.id)));
            expect(results.filter((x) => x.status === 200)).toHaveLength(1);
            expect(results.filter((x) => x.status === 409)).toHaveLength(2);
            expect(await qty(a, sku, 'non_sellable')).toBe(2);
        });

        it('rejected: a reason is needed, no stock moves, no refund; handing the goods back closes it and records who took them', async () => {
            const a = await newBranch('rej'), sku = await newSku(a);
            const sale = await sell(a, sku, 2, '80.00');
            const r = (await receive(clerkId, sale.id, a, sku, 1)).body;
            expect((await request(app).post(`/returns/${r.id}/reject`).set(as(mgrId)).send({})).status).toBe(400);
            expect((await request(app).post(`/returns/${r.id}/reject`).set(as(clerkId)).send({ reason: 'Worn and washed' })).status).toBe(403);
            expect((await request(app).post(`/returns/${r.id}/handback`).set(as(clerkId)).send({ recipient: 'Rami Khoury' })).status).toBe(409);       // not rejected yet
            const stock = [await qty(a, sku, 'sellable'), await qty(a, sku, 'non_sellable')];
            const rejected = await request(app).post(`/returns/${r.id}/reject`).set(as(mgrId)).send({ reason: 'Worn and washed' });
            expect(rejected.body).toMatchObject({ status: 'rejected', refund: null, decision: { by: { id: mgrId }, reason: 'Worn and washed' } });
            expect([await qty(a, sku, 'sellable'), await qty(a, sku, 'non_sellable')]).toEqual(stock);
            expect((await refund(mgrId, r.id, { method: 'cash', amount: '40.00', recipient: 'Rami Khoury' })).status).toBe(409);                  // no refund is due
            expect((await release(mgrId, r.id)).status).toBe(409);
            expect((await approve(mgrId, r.id)).status).toBe(409);
            expect((await request(app).post(`/returns/${r.id}/handback`).set(as(plainId)).send({ recipient: 'Rami Khoury' })).status).toBe(403);
            expect((await request(app).post(`/returns/${r.id}/handback`).set(as(clerkId)).send({ recipient: 'R' })).status).toBe(400);
            const back = await request(app).post(`/returns/${r.id}/handback`).set(as(clerkId)).send({ recipient: 'Rami Khoury' });
            expect(back.body).toMatchObject({ status: 'handed_back', handback: { to: 'Rami Khoury', by: { id: clerkId } } });
            expect([await qty(a, sku, 'sellable'), await qty(a, sku, 'non_sellable')]).toEqual(stock);                                            // handing back changes no business stock
            expect((await request(app).post(`/returns/${r.id}/handback`).set(as(clerkId)).send({ recipient: 'Rami Khoury' })).status).toBe(409);
        });

        it('a customer who kept the goods: they cannot be approved until they are taken into custody', async () => {
            const a = await newBranch('keep'), sku = await newSku(a);
            const sale = await sell(a, sku, 1, '40.00');
            const r = (await receive(clerkId, sale.id, a, sku, 1, { custody: 'customer_keeps' })).body;
            expect(r.custody).toBe('customer_keeps');
            const blocked = await approve(mgrId, r.id);
            expect(blocked.status).toBe(409);
            expect(blocked.body.message).toMatch(/still with the customer/);
            expect((await request(app).post(`/returns/${r.id}/custody`).set(as(plainId))).status).toBe(403);
            expect((await request(app).post(`/returns/${r.id}/custody`).set(as(clerkId))).body.custody).toBe('with_branch');
            expect((await request(app).post(`/returns/${r.id}/custody`).set(as(clerkId))).status).toBe(409);
            expect((await approve(mgrId, r.id)).status).toBe(200);
        });
    });

    describe('release to sale is a separate act of a manager', () => {
        it('approval does not release; the release moves hold to sale once, in whole or in part, and never more than is on hold', async () => {
            const a = await newBranch('rel'), sku = await newSku(a, 10);
            const sale = await sell(a, sku, 3, '120.00');
            const r = (await receive(clerkId, sale.id, a, sku, 3)).body;
            await approve(mgrId, r.id);
            const base = await qty(a, sku, 'sellable');
            expect(await qty(a, sku, 'non_sellable')).toBe(3);
            expect((await release(clerkId, r.id)).status).toBe(403);
            expect((await request(app).post(`/returns/${r.id}/release`).set(as(mgrId)).send({})).status).toBe(400);                         // the key is required
            const lineId = (await get(mgrId, r.id)).lines[0].id;
            const part = await release(mgrId, r.id, { lines: [{ returnLineId: lineId, quantity: 1 }] });
            expect(part.status, JSON.stringify(part.body)).toBe(200);
            expect(part.body.lines[0]).toMatchObject({ releasedQty: 1, onHold: 2 });
            expect([await qty(a, sku, 'sellable'), await qty(a, sku, 'non_sellable')]).toEqual([base + 1, 2]);
            expect((await release(mgrId, r.id, { lines: [{ returnLineId: lineId, quantity: 3 }] })).status).toBe(409);                    // only 2 are left
            expect((await release(mgrId, r.id, { lines: [{ returnLineId: randomUUID(), quantity: 1 }] })).status).toBe(404);
            const k = key();
            const rest = await release(mgrId, r.id, {}, k);
            expect(rest.body.lines[0]).toMatchObject({ releasedQty: 3, onHold: 0 });
            expect([await qty(a, sku, 'sellable'), await qty(a, sku, 'non_sellable')]).toEqual([base + 3, 0]);
            const replay = await release(mgrId, r.id, {}, k);
            expect([replay.status, replay.headers['idempotent-replay']]).toEqual([200, 'true']);
            expect((await release(mgrId, r.id)).status).toBe(409);                                                                          // nothing left on hold
            const diffs = await prisma.$queryRaw<{ sku_id: string }[]>`SELECT sku_id FROM v_stock_reconciliation_diffs WHERE sku_id = ${sku}::uuid`;
            expect(diffs).toEqual([]);
        });

        it('goods disposed of from the hold in the meantime cannot be released; nothing changes', async () => {
            const a = await newBranch('disp'), sku = await newSku(a, 10);
            const sale = await sell(a, sku, 2, '80.00');
            const r = (await receive(clerkId, sale.id, a, sku, 2)).body;
            await approve(mgrId, r.id);
            const gone = await request(app).post('/stock/adjustments').set(as(mgrId)).set('Idempotency-Key', key()).send({ branchId: a, skuId: sku, bucket: 'non_sellable', quantityDelta: -2, reason: 'disposal', note: 'Damaged beyond repair' });
            expect(gone.status, JSON.stringify(gone.body)).toBe(201);
            const refused = await release(mgrId, r.id);
            expect(refused.status).toBe(409);
            expect(refused.body.message).toMatch(/Not enough on hold/);
            expect((await get(mgrId, r.id)).lines[0]).toMatchObject({ releasedQty: 0 });
        });
    });

    describe('the refund is paid separately: cash or Whish, never more than was paid', () => {
        it('partial payments add up to the refund and no further; the status goes from pending to paid; Whish needs no drawer', async () => {
            const a = await newBranch('ref'), sku = await newSku(a);
            const sale = await sell(a, sku, 1, '40.00');
            const r = (await receive(clerkId, sale.id, a, sku, 1)).body;
            expect((await refund(mgrId, r.id, { method: 'cash', amount: '10.00', recipient: 'Rami Khoury' })).status).toBe(409);            // not approved yet
            await approve(mgrId, r.id);
            const first = await refund(mgrId, r.id, { method: 'cash', amount: '10.00', recipient: 'Rami Khoury' });
            expect(first.status, JSON.stringify(first.body)).toBe(201);
            expect(first.body.refund).toMatchObject({ total: '40.00', paid: '10.00', outstanding: '30.00', status: 'pending' });
            expect(first.body.refund.payments[0]).toMatchObject({ method: 'cash', amount: '10.00', recipient: 'Rami Khoury', reference: null, by: { id: mgrId } });
            const tooMuch = await refund(mgrId, r.id, { method: 'cash', amount: '30.01', recipient: 'Rami Khoury' });
            expect(tooMuch.status).toBe(409);
            expect(tooMuch.body.message).toContain('30.00');
            const last = await refund(mgrId, r.id, { method: 'whish', amount: '30.00', recipient: 'Rami Khoury', reference: `WH-${stamp}` });
            expect(last.body.refund).toMatchObject({ paid: '40.00', outstanding: '0.00', status: 'paid' });
            expect(last.body.refund.payments.map((p: { method: string }) => p.method)).toEqual(['cash', 'whish']);
            expect((await refund(mgrId, r.id, { method: 'cash', amount: '0.01', recipient: 'Rami Khoury' })).status).toBe(409);               // all paid
            await expect(prisma.$executeRaw`UPDATE return_refund_payments SET amount = 1 WHERE return_id = ${r.id}::uuid`).rejects.toThrow();
            await expect(prisma.$executeRaw`DELETE FROM return_refund_payments WHERE return_id = ${r.id}::uuid`).rejects.toThrow();
            expect(await qty(a, sku, 'sellable')).toBe(49);                                                                                  // paying does not release the goods
        });

        it('who may pay; a bad body; a retry pays once; 5 payments of 10 at the same moment on 30 left: exactly 3', async () => {
            const a = await newBranch('ref2'), sku = await newSku(a, 50, '30.00');
            const sale = await sell(a, sku, 1, '30.00');
            const r = (await receive(clerkId, sale.id, a, sku, 1)).body;
            await approve(mgrId, r.id);
            expect((await refund(clerkId, r.id, { method: 'cash', amount: '5.00', recipient: 'Rami Khoury' })).status).toBe(403);             // returns.create is not returns.refund
            expect((await request(app).put(`/users/${clerkId}/permissions`).set(as(adminId)).send({ permissions: { 'returns.refund': true } })).status).toBeLessThan(300);
            const k = key();
            const body = { method: 'cash', amount: '5.00', recipient: 'Rami Khoury' };
            const first = await refund(clerkId, r.id, body, k);
            const again = await refund(clerkId, r.id, body, k);
            expect([first.status, again.status, again.headers['idempotent-replay']]).toEqual([201, 201, 'true']);
            expect(again.body.refund.payments).toHaveLength(1);
            expect((await refund(clerkId, r.id, { ...body, amount: '6.00' }, k)).status).toBe(409);
            for (const bad of [{}, { method: 'card', amount: '1', recipient: 'Rami' }, { method: 'cash', amount: '0', recipient: 'Rami' }, { method: 'cash', amount: '1' }, { method: 'cash', amount: '1', recipient: 'Rami', reference: 'WH-1' }]) {
                expect((await refund(mgrId, r.id, bad)).status, JSON.stringify(bad)).toBe(400);
            }
            expect((await request(app).post(`/returns/${r.id}/refunds`).set(as(mgrId)).send(body)).status).toBe(400);                        // the key is required
            await request(app).put(`/users/${clerkId}/permissions`).set(as(adminId)).send({ permissions: { 'returns.refund': false } });
            const racing = await Promise.all(Array.from({ length: 5 }, () => refund(mgrId, r.id, { method: 'cash', amount: '10.00', recipient: 'Rami Khoury' })));
            expect(racing.filter((x) => x.status === 201)).toHaveLength(2);                                                                  // 25.00 left: two of 10.00
            expect((await get(mgrId, r.id)).refund).toMatchObject({ paid: '25.00', outstanding: '5.00' });
        });

        it('a cash refund comes out of the drawer of the branch that pays it; Whish does not; with sessions required, a cash refund needs an open one', async () => {
            const a = await newBranch('drawer'), sku = await newSku(a);
            const sale = await sell(a, sku, 2, '80.00');
            const r = (await receive(clerkId, sale.id, a, sku, 2)).body;
            await approve(mgrId, r.id);
            const session = (await request(app).post('/cash-sessions').set(as(mgrId)).send({ branchId: a, openingCash: '100.00' })).body;
            await sell(a, sku, 1, '40.00');                                                                                                  // 40.00 in cash into the drawer
            expect((await refund(mgrId, r.id, { method: 'cash', amount: '30.00', recipient: 'Rami Khoury' })).status).toBe(201);
            expect((await refund(mgrId, r.id, { method: 'whish', amount: '20.00', recipient: 'Rami Khoury', reference: `WH-${stamp}-d` })).status).toBe(201);
            const view = (await request(app).get(`/cash-sessions/${session.id}`).set(as(mgrId))).body;
            expect(view.totals).toMatchObject({ cashPayments: '40.00', cashRefunds: '30.00', expectedCash: '110.00' });                     // 100 + 40 - 30
            const closed = await request(app).post(`/cash-sessions/${session.id}/close`).set(as(mgrId)).send({ countedCash: '110.00' });
            expect(closed.body.closing).toMatchObject({ expectedCash: '110.00', difference: '0.00' });
            await setSettings({ requireOpenCashSession: true });
            try {
                const none = await refund(mgrId, r.id, { method: 'cash', amount: '10.00', recipient: 'Rami Khoury' });
                expect(none.status).toBe(409);
                expect(none.body.message).toMatch(/open cash session/);
                expect((await refund(mgrId, r.id, { method: 'whish', amount: '10.00', recipient: 'Rami Khoury' })).status).toBe(201);        // Whish never needs the drawer
            } finally { await setSettings({ requireOpenCashSession: false }); }
        });
    });

    describe('who sees the returns', () => {
        it('the receiving branch and the selling branch see it, nobody else; an employee with no returns right sees nothing; the list filters and counts', async () => {
            const a = await newBranch('see'), b = await newBranch('seeb'), sku = await newSku(a);
            const sale = await sell(a, sku, 3, '120.00');
            const r1 = (await receive(clerkId, sale.id, b, sku, 1)).body;
            const r2 = (await receive(clerkId, sale.id, a, sku, 1)).body;
            await approve(mgrId, r2.id);
            expect((await request(app).get(`/returns/${r1.id}`).set(as(clerkId))).status).toBe(200);
            expect((await request(app).get(`/returns/${r1.id}`).set(as(strangerId))).status).toBe(404);
            expect((await request(app).get(`/returns/${r1.id}`).set(as(plainId))).status).toBe(403);
            expect((await request(app).get('/returns/abc').set(as(adminId))).status).toBe(404);
            expect((await request(app).get(`/returns/${randomUUID()}`).set(as(adminId))).status).toBe(404);
            const bySale = await request(app).get(`/returns?saleId=${sale.id}`).set(as(mgrId));
            expect(bySale.body.map((x: { id: string }) => x.id).sort()).toEqual([r1.id, r2.id].sort());
            expect(Number(bySale.headers['x-total-count'])).toBe(2);
            expect(bySale.body.find((x: { id: string }) => x.id === r2.id)).toMatchObject({ status: 'approved', units: 1, refundTotal: '40.00', refundOutstanding: '40.00', saleReference: sale.reference });
            expect((await request(app).get(`/returns?saleId=${sale.id}&status=in_custody`).set(as(mgrId))).body.map((x: { id: string }) => x.id)).toEqual([r1.id]);
            expect((await request(app).get(`/returns?branchId=${b}&saleId=${sale.id}`).set(as(mgrId))).body.map((x: { id: string }) => x.id)).toEqual([r1.id]);        // the one received at b
            expect((await request(app).get(`/returns?saleId=${sale.id}&limit=1&offset=1`).set(as(mgrId))).body).toHaveLength(1);
            expect((await request(app).get(`/returns?saleId=${sale.id}`).set(as(strangerId))).body).toEqual([]);
            expect((await request(app).get('/returns').set(as(plainId))).status).toBe(403);
            for (const q of ['status=lost', 'branchId=abc', 'from=2026-02-30', 'limit=0']) expect((await request(app).get(`/returns?${q}`).set(as(adminId))).status, q).toBe(400);
            expect((await request(app).get('/returns')).status).toBe(401);
        });
    });

    describe('an exchange: a linked return and a new sale, with the net amount', () => {
        const link = (userId: string, returnId: string, body: object) => request(app).post(`/returns/${returnId}/exchange`).set(as(userId)).send(body);

        it('the replacement sale is linked to the approved return and the net amount is kept; nothing is refunded or released by it', async () => {
            const a = await newBranch('ex'), dress = await newSku(a, 50, '40.00'), pricier = await newSku(a, 50, '45.00'), cheaper = await newSku(a, 50, '30.00');
            const original = await sell(a, dress, 1, '40.00');
            const r = (await receive(clerkId, original.id, a, dress, 1)).body;
            await approve(mgrId, r.id);
            const hold = await qty(a, dress, 'non_sellable');
            const swap = await sell(a, pricier, 1, '45.00');                                                    // a 40.00 dress exchanged for a 45.00 one
            const linked = await link(clerkId, r.id, { saleId: swap.id });
            expect(linked.status, JSON.stringify(linked.body)).toBe(200);
            expect(linked.body.exchange).toMatchObject({ saleId: swap.id, saleReference: swap.reference, saleTotal: '45.00', refundTotal: '40.00', net: '5.00', direction: 'customer_pays', linkedBy: { id: clerkId } });
            expect(linked.body.refund).toMatchObject({ total: '40.00', paid: '0.00', outstanding: '40.00', status: 'pending' });               // the exchange does not pay the refund
            expect(await qty(a, dress, 'non_sellable')).toBe(hold);                                                                             // nor release the goods
            // a cheaper replacement: the business owes the difference; the same price: even
            const r2 = (await receive(clerkId, (await sell(a, dress, 1, '40.00')).id, a, dress, 1)).body;
            await approve(mgrId, r2.id);
            const cheap = await link(mgrId, r2.id, { saleId: (await sell(a, cheaper, 1, '30.00')).id });
            expect(cheap.body.exchange).toMatchObject({ net: '-10.00', direction: 'business_pays' });
            const r3 = (await receive(clerkId, (await sell(a, dress, 1, '40.00')).id, a, dress, 1)).body;
            await approve(mgrId, r3.id);
            expect((await link(mgrId, r3.id, { saleId: (await sell(a, dress, 1, '40.00')).id })).body.exchange).toMatchObject({ net: '0.00', direction: 'even' });
            const audit = await request(app).get(`/audit-events?entityType=return&entityId=${r.id}`).set(as(adminId));
            expect(audit.body.map((e: { action: string }) => e.action)).toEqual(expect.arrayContaining(['return.receive', 'return.approve', 'return.exchange']));
        });

        it('what is refused: not approved yet, linked twice, the sale being returned, another branch, a sale made before the goods came, a sale already used, a bad body, no right', async () => {
            const a = await newBranch('ex2'), b = await newBranch('ex2b'), dress = await newSku(a), other = await newSku(a), farAway = await newSku(b);
            const before = await sell(a, other, 1, '40.00');                                                                                    // made BEFORE the return is received
            const original = await sell(a, dress, 2, '80.00');
            const r = (await receive(clerkId, original.id, a, dress, 1)).body;
            const after = await sell(a, other, 1, '40.00');
            expect((await link(clerkId, r.id, { saleId: after.id })).status).toBe(409);                                                          // still in custody: not approved
            await approve(mgrId, r.id);
            expect((await link(clerkId, r.id, { saleId: original.id })).body.message).toMatch(/NEW sale/);
            expect((await link(clerkId, r.id, { saleId: before.id })).body.message).toMatch(/before the goods were received/);
            expect((await link(clerkId, r.id, { saleId: (await sell(b, farAway, 1, '40.00')).id })).body.message).toMatch(/branch that took the goods back/);
            expect((await link(clerkId, r.id, { saleId: randomUUID() })).status).toBe(404);
            for (const body of [{}, { saleId: 'abc' }, { saleId: 5 }]) expect((await link(clerkId, r.id, body)).status, JSON.stringify(body)).toBe(400);
            expect((await link(plainId, r.id, { saleId: after.id })).status).toBe(403);
            expect((await link(strangerId, r.id, { saleId: after.id })).status).toBe(404);
            expect((await link(clerkId, r.id, { saleId: after.id })).status).toBe(200);
            expect((await link(clerkId, r.id, { saleId: after.id })).status).toBe(409);                                                          // linked once
            const second = (await receive(clerkId, original.id, a, dress, 1)).body;
            const third = (await receive(clerkId, (await sell(a, dress, 1, '40.00')).id, a, dress, 1)).body;
            await approve(mgrId, second.id);
            await approve(mgrId, third.id);
            expect((await link(clerkId, second.id, { saleId: after.id })).status).toBe(409);                                                     // made before this return was received
            const newer = await sell(a, other, 1, '40.00');                                                                                       // made after both
            expect((await link(clerkId, second.id, { saleId: newer.id })).status).toBe(200);
            const used = await link(clerkId, third.id, { saleId: newer.id });                                                                     // a sale is the exchange of ONE return only
            expect(used.status).toBe(409);
            expect(used.body.message).toMatch(/already the exchange of/);
        });
    });

    describe('the reports take the refunds off', () => {
        const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Beirut' }).format(new Date());
        const warehouse = async () => {
            const found = (await request(app).get('/branches').set(as(adminId))).body.find((x: { kind: string }) => x.kind === 'warehouse')?.id
                ?? (await request(app).post('/branches').set(as(adminId)).send({ code: `RW${short}`, name: 'Main Warehouse (returns test)', kind: 'warehouse' })).body.id;
            await request(app).patch(`/branches/${found}`).set(as(adminId)).send({ isActive: true });
            return found as string;
        };

        it('sold 3 at 40 (cost 12), 1 comes back: net revenue 80, refunds 40; the profit is that of the 2 the customers kept; a rejected return changes nothing', async () => {
            await warehouse();
            const a = await newBranch('rep'), sku = await newSku(a);
            expect((await request(app).post('/goods-receipts').set(as(adminId)).set('Idempotency-Key', key()).send({ supplierName: `Return Supplier ${short}`, lines: [{ skuId: sku, quantity: 10, unitCost: '12.00' }] })).status).toBe(201);
            const sale = await sell(a, sku, 3, '120.00');
            const range = `branchId=${a}&from=${today}&to=${today}`;
            const before = (await request(app).get(`/reports/sales-summary?${range}`).set(as(mgrId))).body;
            expect(before.totals).toMatchObject({ revenue: '120.00', refunds: '0.00', netRevenue: '120.00' });
            const bad = (await receive(clerkId, sale.id, a, sku, 1)).body;
            await request(app).post(`/returns/${bad.id}/reject`).set(as(mgrId)).send({ reason: 'Worn and washed' });
            const r = (await receive(clerkId, sale.id, a, sku, 1)).body;
            await approve(mgrId, r.id);
            const after = (await request(app).get(`/reports/sales-summary?${range}`).set(as(mgrId))).body;
            expect(after.totals).toMatchObject({ salesCount: 1, revenue: '120.00', refunds: '40.00', netRevenue: '80.00' });
            expect(after.byBranch[0]).toMatchObject({ revenue: '120.00', refunds: '40.00', netRevenue: '80.00' });
            expect(after.byDay.find((d: { day: string }) => d.day === today)).toMatchObject({ refunds: '40.00', netRevenue: '80.00' });
            const profit = (await request(app).get(`/costs/profit?${range}`).set(as(mgrId))).body;
            expect(profit.totals).toEqual({ revenue: '120.00', cost: '36.00', profit: '84.00', unknownCostRevenue: '0.00', salesCount: 1, refunds: '40.00', returnedCost: '12.00', netRevenue: '80.00', netProfit: '56.00' });       // 2 kept: 80 - 24 = 56
        });

        it('a branch that takes back goods sold elsewhere shows the refund at ITS side (it can be negative); the total of all branches is right', async () => {
            const a = await newBranch('rep2'), b = await newBranch('rep2b'), sku = await newSku(a);
            const sale = await sell(a, sku, 2, '80.00');
            const r = (await receive(clerkId, sale.id, b, sku, 1)).body;
            await approve(mgrId, r.id);
            const both = (await request(app).get(`/reports/sales-summary?from=${today}&to=${today}`).set(as(adminId))).body;
            const byBranch = (id: string) => both.byBranch.find((x: { branch: { id: string } }) => x.branch.id === id);
            expect(byBranch(a)).toMatchObject({ revenue: '80.00', refunds: '0.00', netRevenue: '80.00' });
            expect(byBranch(b)).toMatchObject({ revenue: '0.00', refunds: '40.00', netRevenue: '-40.00' });                                  // it paid out what another branch sold
            const rows = both.rows.filter((x: { branch: { id: string } }) => x.branch.id === b);
            expect(rows).toEqual([expect.objectContaining({ salesCount: 0, revenue: '0.00', refunds: '40.00', netRevenue: '-40.00' })]);       // a day with only a refund has its row
            expect(Number(both.totals.netRevenue)).toBeCloseTo(Number(both.totals.revenue) - Number(both.totals.refunds), 2);
        });
    });
});
