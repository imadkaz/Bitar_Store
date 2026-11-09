import 'dotenv/config';
import { vi } from 'vitest';

vi.hoisted(() => {
    process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123456';
    process.env.AUTH_MODE = 'jwt';
});

import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../app';
import { prisma } from '../db';
import { UserRole } from '../models/User.model';
import { UserRepository } from '../repositories/UserRepository';
import { JwtTokenService } from '../services/JwtTokenService';
import { createUserWithPassword } from '../test-helpers/createUserWithPassword';
import { waitForDatabase } from '../test-helpers/waitForDatabase';

// BL-02: a manager puts pieces on hold (they cannot be sold), releases them back on sale, or disposes of them (written off). Always with a reason.
const disposable = process.env.TEST_DB_DISPOSABLE === '1';
const stamp = Date.now();
const short = String(stamp).slice(-8);
const tokens = new JwtTokenService(process.env.JWT_SECRET!);
const as = (id: string) => ({ Authorization: `Bearer ${tokens.sign(id)}` });
const key = () => `hd-${randomUUID()}`;
let counter = 0;

let adminId = '', mgrId = '', clerkId = '', branchId = '';
const newSku = async (opening: number) => {
    const styleId = (await request(app).post('/styles').set(as(adminId)).send({ code: `HD${short}${++counter}`, name: `Hold Dress ${counter}` })).body.id;
    const sku = (await request(app).post('/skus').set(as(adminId)).send({ styleId, skuCode: `HD${short}-${counter}`, size: 'M', color: 'Grey', standardPrice: '10.00' })).body.id as string;
    expect((await request(app).post('/stock/opening').set(as(adminId)).set('Idempotency-Key', key()).send({ branchId, lines: [{ skuId: sku, quantity: opening }] })).status).toBe(201);
    return sku;
};
const adjust = (userId: string, skuId: string, bucket: string, delta: number, reason: string, k = key()) =>
    request(app).post('/stock/adjustments').set(as(userId)).set('Idempotency-Key', k).send({ branchId, skuId, bucket, quantityDelta: delta, reason, note: `Because of ${reason}, checked by hand` });
const qty = async (skuId: string, bucket: string) => (await prisma.stockBalance.findFirst({ where: { branchId, skuId, bucket } }))?.quantity ?? 0;

describe.skipIf(!disposable)('hold, release and disposal (real database)', () => {
    beforeAll(async () => {
        await waitForDatabase(prisma);
        const make = async (tag: string, role: UserRole) => (await createUserWithPassword(new UserRepository(prisma), { email: `${tag}-${stamp}@bitar.test`, password: 'Password#123', fullName: `Test ${tag}`, role }, null)).getId();
        adminId = await make('hdadmin', UserRole.ADMIN);
        mgrId = await make('hdmgr', UserRole.MANAGER);
        clerkId = await make('hdclerk', UserRole.EMPLOYEE);
        branchId = (await request(app).post('/branches').set(as(adminId))).body.id ?? '';
        branchId = (await request(app).post('/branches').set(as(adminId)).send({ code: `HD${short}`, name: 'Hold Branch' })).body.id;
        for (const user of [mgrId, clerkId]) expect((await request(app).put(`/users/${user}/branches/${branchId}`).set(as(adminId))).status).toBe(204);
        expect((await request(app).put(`/users/${clerkId}/permissions`).set(as(adminId)).send({ permissions: { 'adjustments.create': true } })).status).toBeLessThan(300);
    }, 120_000);

    it('hold takes sellable pieces off sale and keeps them; release puts them back; disposal writes them off from the hold: each with a reason, in the ledger and the audit', async () => {
        const sku = await newSku(10);
        const held = await adjust(mgrId, sku, 'sellable', -3, 'hold');
        expect(held.status, JSON.stringify(held.body)).toBe(201);
        expect([await qty(sku, 'sellable'), await qty(sku, 'non_sellable')]).toEqual([7, 3]);
        expect((await adjust(mgrId, sku, 'non_sellable', -2, 'release')).status).toBe(201);
        expect([await qty(sku, 'sellable'), await qty(sku, 'non_sellable')]).toEqual([9, 1]);
        expect((await adjust(mgrId, sku, 'non_sellable', -1, 'disposal')).status).toBe(201);
        expect([await qty(sku, 'sellable'), await qty(sku, 'non_sellable')]).toEqual([9, 0]);                  // one piece is gone: 10 became 9
        const history = (await request(app).get(`/stock/adjustments?skuId=${sku}`).set(as(mgrId))).body as { reason: string; note: string; reference: string }[];
        expect(history.map((h) => h.reason).sort()).toEqual(['disposal', 'hold', 'release']);
        expect((await request(app).get(`/stock/adjustments?skuId=${sku}&reason=disposal`).set(as(mgrId))).body).toHaveLength(1);
        const ledger = await prisma.stockMovement.findMany({ where: { skuId: sku, branchId, movementType: 'adjustment' } });
        expect(ledger.map((m) => `${m.bucket}:${m.quantityDelta}`).sort()).toEqual(['non_sellable:-1', 'non_sellable:-2', 'non_sellable:3', 'sellable:-3', 'sellable:2']);       // every piece that moved is in the ledger
        const diffs = await prisma.$queryRaw<{ sku_id: string }[]>`SELECT sku_id FROM v_stock_reconciliation_diffs WHERE sku_id = ${sku}::uuid`;
        expect(diffs).toEqual([]);                                                                              // the books balance
        const audit = await request(app).get('/audit-events?entityType=adjustment').set(as(adminId));
        expect(JSON.stringify(audit.body)).toContain('"reason":"disposal"');
    });

    it('a held piece cannot be sold; once released it can', async () => {
        const sku = await newSku(2);
        expect((await adjust(mgrId, sku, 'sellable', -2, 'hold')).status).toBe(201);
        const sell = () => request(app).post('/sales').set(as(mgrId)).set('Idempotency-Key', key()).send({ branchId, lines: [{ skuId: sku, quantity: 1 }], payments: [{ method: 'cash', amount: '10.00', tendered: '10.00' }] });
        const refused = await sell();
        expect(refused.status).toBe(409);
        expect(refused.body.details ?? refused.body).toBeTruthy();
        expect((await adjust(mgrId, sku, 'non_sellable', -1, 'release')).status).toBe(201);
        expect((await sell()).status).toBe(201);
    });

    it('the signs and the places are checked; more than there is is a 409 that changes nothing', async () => {
        const sku = await newSku(5);
        expect((await adjust(mgrId, sku, 'sellable', 2, 'hold')).status).toBe(400);                            // hold takes pieces off sale: negative
        expect((await adjust(mgrId, sku, 'non_sellable', -1, 'hold')).status).toBe(400);                       // hold works on pieces that are for sale
        expect((await adjust(mgrId, sku, 'sellable', -1, 'release')).status).toBe(400);                        // release works on pieces on hold
        expect((await adjust(mgrId, sku, 'non_sellable', 1, 'disposal')).status).toBe(400);
        expect((await adjust(mgrId, sku, 'sellable', -1, 'disposal')).status).toBe(400);
        const tooMany = await adjust(mgrId, sku, 'sellable', -6, 'hold');
        expect(tooMany.status).toBe(409);
        expect(JSON.stringify(tooMany.body)).toContain('"available":5');
        expect((await adjust(mgrId, sku, 'non_sellable', -1, 'release')).status).toBe(409);                    // nothing is on hold
        expect((await adjust(mgrId, sku, 'non_sellable', -1, 'disposal')).status).toBe(409);
        expect([await qty(sku, 'sellable'), await qty(sku, 'non_sellable')]).toEqual([5, 0]);
        const noNote = await request(app).post('/stock/adjustments').set(as(mgrId)).set('Idempotency-Key', key()).send({ branchId, skuId: sku, bucket: 'sellable', quantityDelta: -1, reason: 'hold' });
        expect(noNote.status).toBe(400);
    });

    it('only a manager: an employee GRANTED the adjustment right still cannot hold, release or dispose (but can record a loss); the admin can', async () => {
        const sku = await newSku(6);
        for (const [bucket, delta, reason] of [['sellable', -1, 'hold'], ['non_sellable', -1, 'release'], ['non_sellable', -1, 'disposal']] as const) {
            const refused = await adjust(clerkId, sku, bucket, delta, reason);
            expect(refused.status, reason).toBe(403);
            expect(refused.body.message).toContain(reason);
        }
        expect((await adjust(clerkId, sku, 'sellable', -1, 'loss')).status).toBe(201);
        expect((await adjust(adminId, sku, 'sellable', -1, 'hold')).status).toBe(201);
        expect([await qty(sku, 'sellable'), await qty(sku, 'non_sellable')]).toEqual([4, 1]);
    });

    it('a retry with the same key holds once; 6 holds of one piece at the same moment on 4 pieces: exactly 4 work and never more', async () => {
        const sku = await newSku(5);
        const k = key();
        const first = await adjust(mgrId, sku, 'sellable', -2, 'hold', k);
        const again = await adjust(mgrId, sku, 'sellable', -2, 'hold', k);
        expect([first.status, again.status, again.headers['idempotent-replay']]).toEqual([201, 201, 'true']);
        expect([await qty(sku, 'sellable'), await qty(sku, 'non_sellable')]).toEqual([3, 2]);                  // once
        const racing = await newSku(4);
        const results = await Promise.all(Array.from({ length: 6 }, () => adjust(mgrId, racing, 'sellable', -1, 'hold')));
        expect(results.filter((r) => r.status === 201)).toHaveLength(4);
        expect(results.filter((r) => r.status === 409)).toHaveLength(2);
        expect([await qty(racing, 'sellable'), await qty(racing, 'non_sellable')]).toEqual([0, 4]);
    });
});
