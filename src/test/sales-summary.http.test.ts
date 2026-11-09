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

// The revenue of every branch, and the sum of all of them, with what was sold in the shop apart from what was sold online (social media).
const disposable = process.env.TEST_DB_DISPOSABLE === '1';
const stamp = Date.now();
const tokens = new JwtTokenService(process.env.JWT_SECRET!);
const as = (id: string) => ({ Authorization: `Bearer ${tokens.sign(id)}` });
const key = () => `rev-${randomUUID()}`;

let adminId = '', managerAId = '', staffId = '', hamraId = '', saidaId = '', quietId = '', skuId = '';

// the day of the test in Beirut, as the report sees it
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Beirut' }).format(new Date());
const sell = async (userId: string, branchId: string, body: object = {}) => {
    const res = await request(app).post('/sales').set(as(userId)).set('Idempotency-Key', key()).send({ branchId, lines: [{ skuId, quantity: 1 }], payments: [{ method: 'cash', amount: '10.00', tendered: '10.00' }], ...body });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body;
};

describe.skipIf(!disposable)('revenue of every branch and of all together (real database)', () => {
    beforeAll(async () => {
        await waitForDatabase(prisma);
        const make = async (tag: string, role: UserRole) => (await createUserWithPassword(new UserRepository(prisma), { email: `${tag}-${stamp}@bitar.test`, password: 'Password#123', fullName: `Test ${tag}`, role }, adminId)).getId();
        adminId = (await createUserWithPassword(new UserRepository(prisma), { email: `revadmin-${stamp}@bitar.test`, password: 'Password#123', fullName: 'Test revadmin', role: UserRole.ADMIN }, null)).getId();
        managerAId = await make('revmgr', UserRole.MANAGER);
        staffId = await make('revstaff', UserRole.EMPLOYEE);
        hamraId = (await request(app).post('/branches').set(as(adminId)).send({ code: `REVH-${stamp}`, name: 'Revenue Hamra' })).body.id;
        saidaId = (await request(app).post('/branches').set(as(adminId)).send({ code: `REVS-${stamp}`, name: 'Revenue Saida' })).body.id;
        quietId = (await request(app).post('/branches').set(as(adminId)).send({ code: `REVQ-${stamp}`, name: 'Revenue Quiet' })).body.id;
        for (const [user, branch] of [[managerAId, hamraId], [staffId, hamraId]]) expect((await request(app).put(`/users/${user}/branches/${branch}`).set(as(adminId))).status).toBe(204);
        const styleId = (await request(app).post('/styles').set(as(adminId)).send({ code: `REVS${stamp}`, name: 'Revenue Dress' })).body.id;
        skuId = (await request(app).post('/skus').set(as(adminId)).send({ styleId, skuCode: `REV${stamp}-1`, size: 'M', color: 'Grey', standardPrice: '10.00' })).body.id;
        for (const branchId of [hamraId, saidaId]) await request(app).post('/stock/opening').set(as(adminId)).set('Idempotency-Key', key()).send({ branchId, lines: [{ skuId, quantity: 50 }] });
    }, 120_000);

    it('each branch has its own total, the total of all is their sum, the day shows all branches together; shop and online are kept apart', async () => {
        await sell(adminId, hamraId);                                                                                                  // Hamra: 10.00 in the shop
        await sell(adminId, hamraId, { lines: [{ skuId, quantity: 2 }], payments: [{ method: 'cash', amount: '5.00', tendered: '5.00' }, { method: 'whish', amount: '15.00', reference: `REV-${stamp}-A` }] });   // Hamra: 20.00 in the shop
        await sell(adminId, saidaId, { channel: 'social_media', socialPlatform: 'instagram', lines: [{ skuId, quantity: 3 }], payments: [{ method: 'whish', amount: '30.00', reference: `REV-${stamp}-B` }] });       // Saida: 30.00 online
        await sell(adminId, saidaId);                                                                                                  // Saida: 10.00 in the shop
        const res = await request(app).get(`/reports/sales-summary?from=${today}&to=${today}`).set(as(adminId));
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        const by = (id: string) => res.body.byBranch.find((b: { branch: { id: string } }) => b.branch.id === id);
        expect(by(hamraId)).toMatchObject({ salesCount: 2, items: 3, revenue: '30.00', inStore: '30.00', socialMedia: '0.00', cash: '15.00', whish: '15.00' });
        expect(by(saidaId)).toMatchObject({ salesCount: 2, items: 4, revenue: '40.00', inStore: '10.00', socialMedia: '30.00', cash: '10.00', whish: '30.00' });
        expect(by(quietId)).toMatchObject({ salesCount: 0, items: 0, revenue: '0.00', inStore: '0.00', socialMedia: '0.00' });             // a branch that sold nothing still shows
        const sum = (pick: (b: Record<string, string | number>) => number) => res.body.byBranch.reduce((n: number, b: Record<string, string | number>) => n + pick(b), 0);
        expect(Number(res.body.totals.revenue)).toBeCloseTo(sum((b) => Number(b.revenue)), 2);                                              // the total is the sum of the branches
        expect(Number(res.body.totals.inStore) + Number(res.body.totals.socialMedia)).toBeCloseTo(Number(res.body.totals.revenue), 2);       // shop + online = everything
        expect(res.body.totals.salesCount).toBe(sum((b) => Number(b.salesCount)));
        const day = res.body.byDay.find((d: { day: string }) => d.day === today);
        expect(Number(day.revenue)).toBeCloseTo(Number(res.body.totals.revenue), 2);                                                        // one day: the day is the whole
        expect(res.body.rows.filter((r: { branch: { id: string } }) => [hamraId, saidaId].includes(r.branch.id))).toHaveLength(2);       // the detail by branch and day is still there
        expect(res.body.byBranch.map((b: { branch: { id: string } }) => b.branch.id)).toEqual(expect.arrayContaining([hamraId, saidaId, quietId]));
    });

    it('one branch only (branchId): its own figures, and the total is that branch', async () => {
        const res = await request(app).get(`/reports/sales-summary?branchId=${saidaId}&from=${today}&to=${today}`).set(as(adminId));
        expect(res.status).toBe(200);
        expect(res.body.byBranch).toHaveLength(1);
        expect(res.body.byBranch[0]).toMatchObject({ revenue: '40.00', socialMedia: '30.00' });
        expect(res.body.totals).toMatchObject({ salesCount: 2, revenue: '40.00', inStore: '10.00', socialMedia: '30.00' });
    });

    it('a manager sees only the branches that are theirs: the total adds up those only', async () => {
        const res = await request(app).get(`/reports/sales-summary?from=${today}&to=${today}`).set(as(managerAId));
        expect(res.status).toBe(200);
        expect(res.body.byBranch.map((b: { branch: { id: string } }) => b.branch.id)).toEqual([hamraId]);
        expect(res.body.totals).toMatchObject({ salesCount: 2, revenue: '30.00' });
        expect((await request(app).get(`/reports/sales-summary?branchId=${saidaId}&from=${today}&to=${today}`).set(as(managerAId))).status).toBeGreaterThanOrEqual(403);
    });

    it('an employee has no financial reports; a period without sales is all zeros; a bad period is a 400', async () => {
        expect((await request(app).get(`/reports/sales-summary?from=${today}&to=${today}`).set(as(staffId))).status).toBe(403);
        const empty = await request(app).get('/reports/sales-summary?from=2020-01-01&to=2020-01-31').set(as(adminId));
        expect(empty.status).toBe(200);
        expect(empty.body.totals).toMatchObject({ salesCount: 0, revenue: '0.00' });
        expect(empty.body.byDay).toEqual([]);
        for (const q of ['from=2026-13-01', 'from=2026-11-05&to=2026-11-01', 'branchId=abc']) expect((await request(app).get(`/reports/sales-summary?${q}`).set(as(adminId))).status, q).toBe(400);
        expect((await request(app).get('/reports/sales-summary')).status).toBe(401);
    });
});
