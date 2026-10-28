import 'dotenv/config';
import { vi } from 'vitest';

vi.hoisted(() => {
    process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123456';
    process.env.AUTH_MODE = 'jwt';
});

import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../app';
import { prisma } from '../../db';
import { UserRole } from '../../models/User.model';
import { UserRepository } from '../../repositories/UserRepository';
import { JwtTokenService } from '../../services/JwtTokenService';
import { createUserWithPassword } from '../../test-helpers/createUserWithPassword';
import { waitForDatabase } from '../../test-helpers/waitForDatabase';

// Sales write rows that can NEVER be deleted (the stock ledger and the payments are immutable on purpose).
// So these tests run only on a database you can throw away: a local one, a Neon branch, or the CI database.
// Set TEST_DB_DISPOSABLE=1 to run them.
const disposable = process.env.TEST_DB_DISPOSABLE === '1';

const stamp = Date.now();
const mail = (tag: string) => `${tag}-${stamp}@bitar.test`;
const tokens = new JwtTokenService(process.env.JWT_SECRET!);
const as = (id: string) => ({ Authorization: `Bearer ${tokens.sign(id)}` });
const keyOf = () => `sale-${randomUUID()}`;

let adminId = '';
let managerId = '';
let sellerId = '';          // employee at Hamra
let otherId = '';           // employee at Tripoli
let hamraId = '';
let tripoliId = '';
let styleId = '';
let counter = 0;

// key = null sends NO Idempotency-Key header at all (a default parameter would replace undefined with a new key)
const sellAs = (userId: string, body: object, key: string | null = keyOf()) => {
    const req = request(app).post('/sales').set(as(userId));
    return (key === null ? req : req.set('Idempotency-Key', key)).send(body);
};

// a sku with its own stock at Hamra, so every test is independent
async function stockedSku(quantity: number, price = '45.00', branchId = hamraId) {
    const created = await request(app).post('/skus').set(as(managerId)).send({ styleId, skuCode: `SL${stamp}-K${++counter}`, size: `S${counter}`, color: 'Black', standardPrice: price });
    expect(created.status).toBe(201);
    if (quantity > 0) {
        const opening = await request(app).post('/stock/opening').set(as(adminId)).set('Idempotency-Key', keyOf()).send({ branchId, lines: [{ skuId: created.body.id, quantity }] });
        expect(opening.status).toBe(201);
    }
    return created.body.id as string;
}

const quantityOf = async (skuId: string, branchId = hamraId) =>
    (await prisma.stockBalance.findFirst({ where: { skuId, branchId, bucket: 'sellable' } }))?.quantity ?? 0;

const oneLine = (skuId: string, extra: object = {}) => ({ branchId: hamraId, lines: [{ skuId, quantity: 1 }], payments: [{ method: 'cash', amount: '45.00' }], ...extra });

describe.skipIf(!disposable)('sales (real database)', () => {
    beforeAll(async () => {
        await waitForDatabase(prisma);
        const repo = new UserRepository(prisma);
        adminId = (await createUserWithPassword(repo, { email: mail('sadmin'), password: 'Password#123', fullName: 'Sales Admin', role: UserRole.ADMIN }, null)).getId();
        managerId = (await createUserWithPassword(repo, { email: mail('smanager'), password: 'Password#123', fullName: 'Sales Manager', role: UserRole.MANAGER }, adminId)).getId();
        sellerId = (await createUserWithPassword(repo, { email: mail('sseller'), password: 'Password#123', fullName: 'Sara Seller', role: UserRole.EMPLOYEE }, adminId)).getId();
        otherId = (await createUserWithPassword(repo, { email: mail('sother'), password: 'Password#123', fullName: 'Omar Other', role: UserRole.EMPLOYEE }, adminId)).getId();

        hamraId = (await request(app).post('/branches').set(as(adminId)).send({ code: `SH-${stamp}`, name: 'Hamra (sales test)' })).body.id;
        tripoliId = (await request(app).post('/branches').set(as(adminId)).send({ code: `ST-${stamp}`, name: 'Tripoli (sales test)' })).body.id;
        for (const [user, branch] of [[managerId, hamraId], [sellerId, hamraId], [otherId, tripoliId]]) {
            expect((await request(app).put(`/users/${user}/branches/${branch}`).set(as(adminId))).status).toBe(204);
        }
        styleId = (await request(app).post('/styles').set(as(managerId)).send({ code: `SL${stamp}`, name: 'Sales Test Dress' })).body.id;
    }, 120_000);

    describe('a normal sale', () => {
        it('the worked example of BL-04: 1 dress at 45.00 paid 20.00 cash + 25.00 Whish, stock 8 -> 7, everything written once', async () => {
            const skuId = await stockedSku(8);
            const res = await sellAs(sellerId, oneLine(skuId, { payments: [{ method: 'cash', amount: '20', tendered: '50' }, { method: 'whish', amount: '25.00', reference: 'WH-' + randomUUID().slice(0, 8) }] }));
            expect(res.status).toBe(201);
            expect(res.body).toMatchObject({ status: 'completed', channel: 'in_store', currency: 'USD', subtotal: '45.00', totalDiscount: '0.00', total: '45.00', totalPaid: '45.00', soldBy: { id: sellerId, name: 'Sara Seller' } });
            expect(res.body.reference).toMatch(/^S-\d{8}$/);
            expect(res.body.lines).toEqual([expect.objectContaining({ lineNo: 1, skuId, quantity: 1, unitPrice: '45.00', discount: null, lineTotal: '45.00', size: expect.any(String), styleName: 'Sales Test Dress' })]);
            expect(res.body.payments).toEqual([
                { method: 'cash', amount: '20.00', tendered: '50.00', change: '30.00', reference: null },
                { method: 'whish', amount: '25.00', tendered: null, change: null, reference: expect.stringMatching(/^WH-/) },
            ]);

            expect(await quantityOf(skuId)).toBe(7);
            const ledger = await prisma.stockMovement.findMany({ where: { skuId, movementType: 'sale' } });
            expect(ledger).toHaveLength(1);
            expect(ledger[0]).toMatchObject({ quantityDelta: -1, balanceAfter: 7, saleId: res.body.id, actorUserId: sellerId, bucket: 'sellable' });
            const row = await prisma.sale.findUnique({ where: { id: res.body.id }, include: { lines: true, payments: true } });
            expect(row?.lines).toHaveLength(1);
            expect(row?.payments).toHaveLength(2);
            expect(row?.createdBy).toBe(sellerId);
            const key = await prisma.idempotencyKey.findUnique({ where: { id: row!.idempotencyKeyId } });
            expect(key).toMatchObject({ operation: 'sale.create', resourceType: 'sale', resourceId: res.body.id, responseStatus: 201 });
            expect(key?.completedAt).not.toBeNull();
        });

        it('the receipt can be read again, listed for the shop day, and the stock view agrees', async () => {
            const skuId = await stockedSku(3);
            const sale = (await sellAs(sellerId, oneLine(skuId))).body;
            const again = await request(app).get(`/sales/${sale.id}`).set(as(sellerId));
            expect(again.status).toBe(200);
            expect(again.body).toEqual(JSON.parse(JSON.stringify(sale)));
            const today = await request(app).get(`/sales?branchId=${hamraId}`).set(as(sellerId));
            expect(today.status).toBe(200);
            expect(today.body.businessDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
            expect(today.body.sales.map((s: { id: string }) => s.id)).toContain(sale.id);
            const stock = await request(app).get(`/stock?branchId=${hamraId}&search=${`SL${stamp}-K${counter}`}`).set(as(sellerId));
            expect(stock.body.find((i: { sku: { id: string } }) => i.sku.id === skuId)).toMatchObject({ sellable: 2, nonSellable: 0, inTransit: 0 });
        });

        it('the price comes from the catalog, and a price change later does not touch an old sale', async () => {
            const skuId = await stockedSku(5, '30.00');
            const sale = (await sellAs(sellerId, { branchId: hamraId, lines: [{ skuId, quantity: 2, unitPrice: '1.00' }], payments: [{ method: 'cash', amount: '60' }] })).body;
            expect(sale.lines[0].unitPrice).toBe('30.00');
            await request(app).put(`/skus/${skuId}/price`).set(as(managerId)).send({ price: '99.00' });
            expect((await request(app).get(`/sales/${sale.id}`).set(as(sellerId))).body.lines[0].unitPrice).toBe('30.00');
            const next = await sellAs(sellerId, { branchId: hamraId, lines: [{ skuId, quantity: 1 }], payments: [{ method: 'cash', amount: '99' }] });
            expect(next.body.lines[0].unitPrice).toBe('99.00');
        });

        it('a social media sale records its platform', async () => {
            const skuId = await stockedSku(2);
            const res = await sellAs(sellerId, oneLine(skuId, { channel: 'social_media', socialPlatform: 'instagram', note: 'collected by courier' }));
            expect(res.body).toMatchObject({ channel: 'social_media', socialPlatform: 'instagram', note: 'collected by courier' });
        });
    });

    describe('discounts', () => {
        it('an employee cannot give one (403) and nothing is sold; a manager can, and the sale shows the approver and the reason', async () => {
            const skuId = await stockedSku(4);
            const percent = { type: 'percent', percent: '10', reason: 'holiday' };
            const refused = await sellAs(sellerId, oneLine(skuId, { lines: [{ skuId, quantity: 1, discount: percent }], payments: [{ method: 'cash', amount: '40.50' }] }));
            expect(refused.status).toBe(403);
            expect(refused.body.message).toBe('Missing permission: discounts.apply');
            expect(await quantityOf(skuId)).toBe(4);

            const ok = await sellAs(managerId, oneLine(skuId, { lines: [{ skuId, quantity: 1, discount: percent }], payments: [{ method: 'cash', amount: '40.50' }] }));
            expect(ok.status).toBe(201);
            expect(ok.body).toMatchObject({ subtotal: '45.00', totalDiscount: '4.50', total: '40.50' });
            expect(ok.body.lines[0].discount).toEqual({ type: 'percent', percent: '10.00', reason: 'holiday', approvedBy: managerId });
            const line = await prisma.saleLine.findFirst({ where: { saleId: ok.body.id } });
            expect(line).toMatchObject({ reductionType: 'percent', reductionReason: 'holiday', reducedBy: managerId });
            expect(line?.reductionPercent?.toFixed(2)).toBe('10.00');
        });

        it('a price override works, can never be above the catalog price, and needs a reason', async () => {
            const skuId = await stockedSku(6);
            const sale = (unitPrice: string, reason?: string) =>
                sellAs(managerId, oneLine(skuId, { lines: [{ skuId, quantity: 2, discount: { type: 'override', unitPrice, ...(reason ? { reason } : {}) } }], payments: [{ method: 'cash', amount: (Number(unitPrice) * 2).toFixed(2) }] }));
            const ok = await sale('40', 'stain');
            expect(ok.status).toBe(201);
            expect(ok.body.lines[0]).toMatchObject({ unitPrice: '45.00', lineTotal: '80.00', discount: { type: 'override', unitPrice: '40.00', reason: 'stain' } });
            expect((await sale('45.01', 'too high')).status).toBe(400);
            expect((await sale('40')).status).toBe(400);
        });

        it('100 percent off is a free sale with no payments', async () => {
            const skuId = await stockedSku(2);
            const res = await sellAs(managerId, oneLine(skuId, { lines: [{ skuId, quantity: 1, discount: { type: 'percent', percent: '100', reason: 'gift' } }], payments: [] }));
            expect(res.status).toBe(201);
            expect(res.body).toMatchObject({ total: '0.00', totalPaid: '0.00', payments: [] });
            expect(await quantityOf(skuId)).toBe(1);
        });
    });

    describe('not enough stock', () => {
        it('409 with the items that are short; nothing is sold, the stock is untouched, the alert is recorded once even if retried', async () => {
            const ok = await stockedSku(10);
            const scarce = await stockedSku(3);
            const key = keyOf();
            const attempt = () => sellAs(sellerId, { branchId: hamraId, lines: [{ skuId: ok, quantity: 2 }, { skuId: scarce, quantity: 4 }], payments: [{ method: 'cash', amount: '270' }] }, key);
            const first = await attempt();
            expect(first.status).toBe(409);
            expect(first.body.message).toBe('Not enough stock for one or more items');
            expect(first.body.details).toEqual([{ skuId: scarce, skuCode: expect.stringMatching(/^SL/), requested: 4, available: 3 }]);
            await attempt();

            expect(await quantityOf(ok)).toBe(10);
            expect(await quantityOf(scarce)).toBe(3);
            expect(await prisma.stockMovement.count({ where: { skuId: { in: [ok, scarce] }, movementType: 'sale' } })).toBe(0);
            expect(await prisma.idempotencyKey.count({ where: { key } })).toBe(0);              // the key was undone, the client may retry
            const alerts = await prisma.stockAlert.findMany({ where: { skuId: scarce, branchId: hamraId } });
            expect(alerts).toHaveLength(1);
            expect(alerts[0]).toMatchObject({ requestedQuantity: 4, availableQuantity: 3, actorUserId: sellerId, operation: 'sale.create', idempotencyKey: key });
        });

        it('a sku that has no stock at the branch counts as 0', async () => {
            const nothing = await stockedSku(0);
            const res = await sellAs(sellerId, oneLine(nothing));
            expect(res.status).toBe(409);
            expect(res.body.details[0]).toMatchObject({ requested: 1, available: 0 });
        });
    });

    describe('retries and the idempotency key', () => {
        it('the same request with the same key is NOT sold twice: same sale back, flagged as a replay, stock lowered once', async () => {
            const skuId = await stockedSku(5);
            const key = keyOf();
            const first = await sellAs(sellerId, oneLine(skuId), key);
            const second = await sellAs(sellerId, oneLine(skuId), key);
            expect(first.status).toBe(201);
            expect(second.status).toBe(201);
            expect(first.headers['idempotent-replay']).toBeUndefined();
            expect(second.headers['idempotent-replay']).toBe('true');
            expect(second.body.id).toBe(first.body.id);
            expect(await quantityOf(skuId)).toBe(4);
            expect(await prisma.sale.count({ where: { lines: { some: { skuId } } } })).toBe(1);
        });

        it('the same key with ANOTHER request is refused (409)', async () => {
            const skuId = await stockedSku(5);
            const key = keyOf();
            await sellAs(sellerId, oneLine(skuId), key);
            const other = await sellAs(sellerId, { branchId: hamraId, lines: [{ skuId, quantity: 2 }], payments: [{ method: 'cash', amount: '90' }] }, key);
            expect(other.status).toBe(409);
            expect(other.body.message).toMatch(/different request/);
            expect(await quantityOf(skuId)).toBe(4);
        });

        it('the key is required (8 to 200 characters)', async () => {
            const skuId = await stockedSku(5);
            for (const key of [null, 'short', ' ', 'x'.repeat(201)]) {
                const res = await sellAs(sellerId, oneLine(skuId), key);
                expect(res.status, String(key)).toBe(400);
                expect(res.body.message).toMatch(/Idempotency-Key/);
            }
            expect(await quantityOf(skuId)).toBe(5);
        });
    });

    describe('many things at the same moment', () => {
        it('5 cashiers sell the LAST unit at once: exactly one sale, four clean 409, the balance is 0 and never negative', async () => {
            const skuId = await stockedSku(1);
            const sellers = [sellerId, managerId, adminId, sellerId, managerId];
            const results = await Promise.all(sellers.map((userId) => sellAs(userId, oneLine(skuId))));
            expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409, 409]);
            expect(await quantityOf(skuId)).toBe(0);
            expect(await prisma.stockMovement.count({ where: { skuId, movementType: 'sale' } })).toBe(1);
            expect(await prisma.sale.count({ where: { lines: { some: { skuId } } } })).toBe(1);
            const winner = results.find((r) => r.status === 201)!;
            const loserBodies = results.filter((r) => r.status === 409).map((r) => r.body.details[0]);
            expect(loserBodies.every((d: { available: number }) => d.available === 0)).toBe(true);
            expect(winner.body.total).toBe('45.00');
        });

        it('10 sales of 1 unit each against a stock of 6: exactly 6 succeed, the stock ends at 0', async () => {
            const skuId = await stockedSku(6);
            const results = await Promise.all(Array.from({ length: 10 }, () => sellAs(sellerId, oneLine(skuId))));
            expect(results.filter((r) => r.status === 201)).toHaveLength(6);
            expect(results.filter((r) => r.status === 409)).toHaveLength(4);
            expect(results.filter((r) => r.status >= 500)).toHaveLength(0);
            expect(await quantityOf(skuId)).toBe(0);
            const ledger = await prisma.stockMovement.findMany({ where: { skuId, movementType: 'sale' }, orderBy: { occurredAt: 'asc' } });
            expect(ledger).toHaveLength(6);
            expect(ledger.map((m) => m.balanceAfter).sort()).toEqual([0, 1, 2, 3, 4, 5]);     // a clean countdown, no gaps, no repeats
        });

        it('the SAME request sent 4 times at once (a nervous double click): ONE sale, the others get that same sale back', async () => {
            const skuId = await stockedSku(5);
            const key = keyOf();
            const results = await Promise.all([1, 2, 3, 4].map(() => sellAs(sellerId, oneLine(skuId), key)));
            expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201]);
            expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
            expect(results.filter((r) => r.headers['idempotent-replay'] === 'true')).toHaveLength(3);
            expect(await quantityOf(skuId)).toBe(4);
            expect(await prisma.stockMovement.count({ where: { skuId, movementType: 'sale' } })).toBe(1);
            expect(await prisma.salePayment.count({ where: { saleId: results[0].body.id } })).toBe(1);
        });

        it('sales that buy the same two items in OPPOSITE order never wait on each other forever (no deadlock)', async () => {
            const a = await stockedSku(30);
            const b = await stockedSku(30);
            const sale = (first: string, second: string) => sellAs(sellerId, { branchId: hamraId, lines: [{ skuId: first, quantity: 1 }, { skuId: second, quantity: 1 }], payments: [{ method: 'cash', amount: '90' }] });
            const n = process.env.CI ? 20 : 8;   // a remote database (Neon) is too slow for 20 sales at once
            const results = await Promise.all(Array.from({ length: n }, (_, i) => (i % 2 === 0 ? sale(a, b) : sale(b, a))));
            expect(results.filter((r) => r.status !== 201).map((r) => r.status)).toEqual([]);
            expect(await quantityOf(a)).toBe(30 - n);
            expect(await quantityOf(b)).toBe(30 - n);
        });

        it('two BRANCHES selling the same sku at the same moment never wait for each other: each branch has its own stock', async () => {
            const skuId = await stockedSku(5);                          // 5 at Hamra
            await request(app).post('/stock/opening').set(as(adminId)).set('Idempotency-Key', keyOf()).send({ branchId: tripoliId, lines: [{ skuId, quantity: 5 }] });   // and 5 at Tripoli
            const atHamra = Array.from({ length: 5 }, () => sellAs(sellerId, oneLine(skuId)));
            const atTripoli = Array.from({ length: 5 }, () => sellAs(otherId, { branchId: tripoliId, lines: [{ skuId, quantity: 1 }], payments: [{ method: 'cash', amount: '45.00' }] }));
            const results = await Promise.all([...atHamra, ...atTripoli]);
            expect(results.map((r) => r.status)).toEqual(Array(10).fill(201));     // all ten sold: neither branch took stock from the other
            expect(await quantityOf(skuId, hamraId)).toBe(0);
            expect(await quantityOf(skuId, tripoliId)).toBe(0);
            // and one more sale at either branch is refused: each branch ran out of ITS OWN units
            expect((await sellAs(sellerId, oneLine(skuId))).status).toBe(409);
        });

        it('two sales paid with the SAME Whish reference at once: one wins, the other is undone completely', async () => {
            const skuId = await stockedSku(5);
            const reference = 'WH-RACE-' + randomUUID().slice(0, 8);
            const results = await Promise.all([1, 2].map(() => sellAs(sellerId, oneLine(skuId, { payments: [{ method: 'whish', amount: '45', reference }] }))));
            expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
            expect(await quantityOf(skuId)).toBe(4);
            expect(await prisma.stockMovement.count({ where: { skuId, movementType: 'sale' } })).toBe(1);
            expect(await prisma.salePayment.count({ where: { whishReference: reference } })).toBe(1);
        });
    });

    describe('payments', () => {
        it('must add up to the total exactly; a bad payment leaves nothing behind', async () => {
            const skuId = await stockedSku(5);
            const bad = [[{ method: 'cash', amount: '44.99' }], [{ method: 'cash', amount: '45.01' }], [], [{ method: 'card', amount: '45' }], [{ method: 'cash', amount: '45', tendered: '40' }], [{ method: 'whish', amount: '45' }], [{ method: 'cash', amount: 'abc' }]];
            for (const payments of bad) expect((await sellAs(sellerId, oneLine(skuId, { payments }))).status, JSON.stringify(payments)).toBe(400);
            expect(await quantityOf(skuId)).toBe(5);
            expect(await prisma.sale.count({ where: { lines: { some: { skuId } } } })).toBe(0);
        });

        it('a Whish reference can pay only ONE sale, in any letter case', async () => {
            const skuId = await stockedSku(5);
            const reference = 'WH-ONCE-' + randomUUID().slice(0, 8);
            expect((await sellAs(sellerId, oneLine(skuId, { payments: [{ method: 'whish', amount: '45', reference }] }))).status).toBe(201);
            const reuse = await sellAs(sellerId, oneLine(skuId, { payments: [{ method: 'whish', amount: '45', reference: reference.toLowerCase() }] }));
            expect(reuse.status).toBe(409);
            expect(reuse.body.message).toMatch(/already used/);
            expect(await quantityOf(skuId)).toBe(4);
        });

        it('payments are written once and can never be changed or deleted, even by someone with database access', async () => {
            const skuId = await stockedSku(2);
            const sale = (await sellAs(sellerId, oneLine(skuId))).body;
            await expect(prisma.salePayment.deleteMany({ where: { saleId: sale.id } })).rejects.toThrow();
            await expect(prisma.salePayment.updateMany({ where: { saleId: sale.id }, data: { amount: 1 } })).rejects.toThrow();
            expect(await prisma.salePayment.count({ where: { saleId: sale.id } })).toBe(1);
        });
    });

    describe('who may sell where, and what', () => {
        it('an employee sells only at their own branch; an admin anywhere; reading follows the same rule', async () => {
            const skuId = await stockedSku(3);
            const tripoliSku = await stockedSku(3, '45.00', tripoliId);
            expect((await sellAs(otherId, oneLine(skuId))).status).toBe(403);                                  // Omar works at Tripoli
            expect((await sellAs(otherId, { branchId: tripoliId, lines: [{ skuId: tripoliSku, quantity: 1 }], payments: [{ method: 'cash', amount: '45' }] })).status).toBe(201);
            const adminSale = await sellAs(adminId, oneLine(skuId));
            expect(adminSale.status).toBe(201);

            expect((await request(app).get(`/sales/${adminSale.body.id}`).set(as(otherId))).status).toBe(404);   // not his branch: looks like it does not exist
            expect((await request(app).get(`/sales?branchId=${hamraId}`).set(as(otherId))).status).toBe(403);
            expect((await request(app).get(`/stock?branchId=${hamraId}`).set(as(otherId))).status).toBe(403);
            expect((await request(app).get(`/sales/${adminSale.body.id}`).set(as(sellerId))).status).toBe(200);
        });

        it('needs a login; unknown branch is 404, inactive sku is 409, unknown sku is 404', async () => {
            const skuId = await stockedSku(3);
            expect((await request(app).post('/sales').set('Idempotency-Key', keyOf()).send(oneLine(skuId))).status).toBe(401);
            expect((await sellAs(adminId, oneLine(skuId, { branchId: randomUUID() }))).status).toBe(404);
            expect((await sellAs(sellerId, oneLine(randomUUID()))).status).toBe(404);
            await request(app).patch(`/skus/${skuId}`).set(as(managerId)).send({ isActive: false });
            const retired = await sellAs(sellerId, oneLine(skuId));
            expect(retired.status).toBe(409);
            expect(retired.body.message).toMatch(/not for sale/);
            expect(await quantityOf(skuId)).toBe(3);
        });

        it('every bad request is a 400 with a message, never a 500', async () => {
            const skuId = await stockedSku(3);
            const bad: unknown[] = [
                {}, 'text', [], oneLine(skuId, { branchId: 'abc' }), oneLine(skuId, { lines: [] }), oneLine(skuId, { lines: 'x' }),
                oneLine(skuId, { lines: [{ skuId: 'abc', quantity: 1 }] }), oneLine(skuId, { lines: [{ skuId, quantity: 0 }] }), oneLine(skuId, { lines: [{ skuId, quantity: 1.5 }] }),
                oneLine(skuId, { lines: [{ skuId, quantity: '1' }] }), oneLine(skuId, { lines: [null] }), oneLine(skuId, { lines: [{ skuId, quantity: 1 }, { skuId, quantity: 1 }] }),
                oneLine(skuId, { channel: 'online' }), oneLine(skuId, { channel: 'social_media' }), oneLine(skuId, { note: 5 }), oneLine(skuId, { payments: 'x' }),
            ];
            for (const body of bad) {
                const res = await sellAs(sellerId, body as object);
                expect(res.status, JSON.stringify(body)).toBe(400);
                expect(typeof res.body.message).toBe('string');
            }
            const broken = await request(app).post('/sales').set(as(sellerId)).set('Idempotency-Key', keyOf()).set('Content-Type', 'application/json').send('{"branchId":');
            expect(broken.status).toBe(400);
            expect(await quantityOf(skuId)).toBe(3);
        });

        it('reading: unknown or malformed sale id is 404; a bad date or limit is 400', async () => {
            expect((await request(app).get(`/sales/${randomUUID()}`).set(as(sellerId))).status).toBe(404);
            expect((await request(app).get('/sales/abc').set(as(sellerId))).status).toBe(404);
            for (const q of ['', 'branchId=abc', `branchId=${hamraId}&date=2026-02-30`, `branchId=${hamraId}&date=today`, `branchId=${hamraId}&limit=0`, `branchId=${hamraId}&limit=201`]) {
                expect((await request(app).get(`/sales?${q}`).set(as(sellerId))).status, q).toBe(400);
            }
            expect((await request(app).get(`/sales?branchId=${hamraId}&date=2020-01-01`).set(as(sellerId))).body.sales).toEqual([]);
        });
    });

    describe('opening stock', () => {
        it('only people with the adjustments permission, at a branch they reach; once per sku; safe to retry', async () => {
            const created = await request(app).post('/skus').set(as(managerId)).send({ styleId, skuCode: `SL${stamp}-OPEN${++counter}`, size: `O${counter}`, color: 'Red', standardPrice: '10' });
            const skuId = created.body.id;
            const lines = [{ skuId, quantity: 12 }];
            expect((await request(app).post('/stock/opening').set(as(sellerId)).set('Idempotency-Key', keyOf()).send({ branchId: hamraId, lines })).status).toBe(403);
            expect((await request(app).post('/stock/opening').set(as(managerId)).set('Idempotency-Key', keyOf()).send({ branchId: tripoliId, lines })).status).toBe(403);

            const key = keyOf();
            const first = await request(app).post('/stock/opening').set(as(managerId)).set('Idempotency-Key', key).send({ branchId: hamraId, lines });
            expect(first.status).toBe(201);
            expect(first.body).toMatchObject({ lines: 1 });
            const replay = await request(app).post('/stock/opening').set(as(managerId)).set('Idempotency-Key', key).send({ branchId: hamraId, lines });
            expect(replay.status).toBe(201);
            expect(replay.headers['idempotent-replay']).toBe('true');
            expect(replay.body.batchId).toBe(first.body.batchId);
            expect(await quantityOf(skuId)).toBe(12);

            const again = await request(app).post('/stock/opening').set(as(managerId)).set('Idempotency-Key', keyOf()).send({ branchId: hamraId, lines: [{ skuId, quantity: 99 }] });
            expect(again.status).toBe(409);
            expect(await quantityOf(skuId)).toBe(12);
            const ledger = await prisma.stockMovement.findMany({ where: { skuId } });
            expect(ledger).toEqual([expect.objectContaining({ movementType: 'opening', quantityDelta: 12, balanceAfter: 12, importBatchId: first.body.batchId })]);

            for (const body of [{}, { branchId: hamraId, lines: [] }, { branchId: hamraId, lines: [{ skuId, quantity: 0 }] }, { branchId: 'abc', lines }, { branchId: hamraId, lines: [{ skuId: randomUUID(), quantity: 1 }] }]) {
                const res = await request(app).post('/stock/opening').set(as(adminId)).set('Idempotency-Key', keyOf()).send(body);
                expect([400, 404], JSON.stringify(body)).toContain(res.status);
            }
        });
    });

    describe('the books always balance', () => {
        it('after all of this, the stock audit view and the payment audit view are EMPTY for these branches', async () => {
            const stockDiffs = await prisma.$queryRaw<{ sku_id: string }[]>`SELECT sku_id FROM v_stock_reconciliation_diffs WHERE branch_id IN (${hamraId}::uuid, ${tripoliId}::uuid)`;
            expect(stockDiffs).toEqual([]);
            const paymentDiffs = await prisma.$queryRaw<{ sale_id: string }[]>`SELECT v.sale_id FROM v_sale_payment_diffs v JOIN sales s ON s.id = v.sale_id WHERE s.branch_id IN (${hamraId}::uuid, ${tripoliId}::uuid)`;
            expect(paymentDiffs).toEqual([]);
            const negative = await prisma.stockBalance.count({ where: { branchId: { in: [hamraId, tripoliId] }, quantity: { lt: 0 } } });
            expect(negative).toBe(0);
        });
    });
});
