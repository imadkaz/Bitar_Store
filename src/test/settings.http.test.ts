import 'dotenv/config';
import { vi } from 'vitest';

vi.hoisted(() => {
    process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123456';
    process.env.AUTH_MODE = 'jwt';
});

import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../app';
import { prisma } from '../db';
import { UserRole } from '../models/User.model';
import { UserRepository } from '../repositories/UserRepository';
import { JwtTokenService } from '../services/JwtTokenService';
import { createUserWithPassword } from '../test-helpers/createUserWithPassword';
import { waitForDatabase } from '../test-helpers/waitForDatabase';

const disposable = process.env.TEST_DB_DISPOSABLE === '1';
const stamp = Date.now();
const tokens = new JwtTokenService(process.env.JWT_SECRET!);
const as = (id: string) => ({ Authorization: `Bearer ${tokens.sign(id)}` });
let adminId = '', managerId = '', staffId = '';

describe.skipIf(!disposable)('settings (real database)', () => {
    beforeAll(async () => {
        await waitForDatabase(prisma);
        const make = async (tag: string, role: UserRole) => (await createUserWithPassword(new UserRepository(prisma), { email: `${tag}-${stamp}@bitar.test`, password: 'Password#123', fullName: `Test ${tag}`, role }, null)).getId();
        adminId = await make('setadmin', UserRole.ADMIN);
        managerId = await make('setmgr', UserRole.MANAGER);
        staffId = await make('setstaff', UserRole.EMPLOYEE);
        await prisma.$executeRaw`DELETE FROM settings`;
    }, 120_000);

    it('everyone signed in reads them, with the defaults for what was never set', async () => {
        for (const who of [adminId, managerId, staffId]) {
            const res = await request(app).get('/settings').set(as(who));
            expect(res.status).toBe(200);
            expect(res.body).toEqual({ exchangeRateUsdLbp: null, returnPeriodDays: 14, defaultReservationDays: 3, requireOpenCashSession: false });
        }
        expect((await request(app).get('/settings')).status).toBe(401);
    });

    it('a manager changes only what is sent; the rest stays; it is remembered and audited with before and after', async () => {
        const first = await request(app).put('/settings').set(as(managerId)).send({ exchangeRateUsdLbp: 89500, returnPeriodDays: 30 });
        expect(first.status, JSON.stringify(first.body)).toBe(200);
        expect(first.body).toEqual({ exchangeRateUsdLbp: 89500, returnPeriodDays: 30, defaultReservationDays: 3, requireOpenCashSession: false });
        const second = await request(app).put('/settings').set(as(adminId)).send({ requireOpenCashSession: true, exchangeRateUsdLbp: null });
        expect(second.body).toEqual({ exchangeRateUsdLbp: null, returnPeriodDays: 30, defaultReservationDays: 3, requireOpenCashSession: true });
        expect((await request(app).get('/settings').set(as(staffId))).body).toEqual(second.body);          // what the till reads
        const audit = await request(app).get('/audit-events?entityType=settings').set(as(adminId));
        const changes = audit.body.filter((e: { action: string }) => e.action === 'settings.update').flatMap((e: { details: { changed: unknown[] } }) => e.details.changed);
        expect(changes).toEqual(expect.arrayContaining([{ setting: 'returnPeriodDays', before: 14, after: 30 }, { setting: 'requireOpenCashSession', before: false, after: true }]));
        await request(app).put('/settings').set(as(adminId)).send({ requireOpenCashSession: false });
    });

    it('sending the same value again changes nothing and writes no audit event', async () => {
        await request(app).put('/settings').set(as(adminId)).send({ defaultReservationDays: 5 });
        const before = (await request(app).get('/audit-events?entityType=settings').set(as(adminId))).body.length;
        const same = await request(app).put('/settings').set(as(adminId)).send({ defaultReservationDays: 5 });
        expect(same.status).toBe(200);
        expect((await request(app).get('/audit-events?entityType=settings').set(as(adminId))).body.length).toBe(before);
    });

    it('an employee cannot change them; every bad value is a 400 and changes nothing', async () => {
        expect((await request(app).put('/settings').set(as(staffId)).send({ returnPeriodDays: 7 })).status).toBe(403);
        expect((await request(app).put('/settings').send({ returnPeriodDays: 7 })).status).toBe(401);
        const bad: unknown[] = [{}, [], 'x', { colour: 'red' }, { returnPeriodDays: -1 }, { returnPeriodDays: 366 }, { returnPeriodDays: 1.5 }, { returnPeriodDays: '7' }, { exchangeRateUsdLbp: 0 }, { exchangeRateUsdLbp: 12.5 }, { exchangeRateUsdLbp: 10_000_001 },
            { defaultReservationDays: 0 }, { defaultReservationDays: 61 }, { requireOpenCashSession: 'yes' }, { requireOpenCashSession: 1 }, { returnPeriodDays: 7, colour: 'red' }];
        const before = (await request(app).get('/settings').set(as(adminId))).body;
        for (const body of bad) expect((await request(app).put('/settings').set(as(adminId)).send(body as object)).status, JSON.stringify(body)).toBe(400);
        expect((await request(app).get('/settings').set(as(adminId))).body).toEqual(before);
    });
});
