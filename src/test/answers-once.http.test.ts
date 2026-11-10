import 'dotenv/config';
import { vi } from 'vitest';

vi.hoisted(() => {
    process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123456';
    process.env.AUTH_MODE = 'jwt';
});

import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../app';
import { prisma } from '../db';
import { UserRole } from '../models/User.model';
import { UserRepository } from '../repositories/UserRepository';
import { JwtTokenService } from '../services/JwtTokenService';
import { createUserWithPassword } from '../test-helpers/createUserWithPassword';
import { waitForDatabase } from '../test-helpers/waitForDatabase';
import logger from '../utils/logger';

// A handler that answers TWICE still gives the client a good answer, but the server logs an "Unhandled Error" and a false 500 (it happened with GET /stock).
// Every read of the API is called here, and none may log an error.
const disposable = process.env.TEST_DB_DISPOSABLE === '1';
const stamp = Date.now();
const tokens = new JwtTokenService(process.env.JWT_SECRET!);
let adminId = '', branchId = '', skuId = '', styleId = '', saleId = '';
const errors: unknown[][] = [];

describe.skipIf(!disposable)('every read answers once (real database)', () => {
    beforeAll(async () => {
        await waitForDatabase(prisma);
        adminId = (await createUserWithPassword(new UserRepository(prisma), { email: `once-${stamp}@bitar.test`, password: 'Password#123', fullName: 'Test once', role: UserRole.ADMIN }, null)).getId();
        const as = { Authorization: `Bearer ${tokens.sign(adminId)}` };
        branchId = (await request(app).post('/branches').set(as).send({ code: `ON${String(stamp).slice(-8)}`, name: 'Answers Once' })).body.id;
        styleId = (await request(app).post('/styles').set(as).send({ code: `ON${String(stamp).slice(-8)}`, name: 'Once Dress' })).body.id;
        skuId = (await request(app).post('/skus').set(as).send({ styleId, skuCode: `ON${String(stamp).slice(-8)}-1`, size: 'M', color: 'Grey', standardPrice: '10.00' })).body.id;
        await request(app).post('/stock/opening').set(as).set('Idempotency-Key', `once-${stamp}`).send({ branchId, lines: [{ skuId, quantity: 5 }] });
        saleId = (await request(app).post('/sales').set(as).set('Idempotency-Key', `once-s-${stamp}`).send({ branchId, lines: [{ skuId, quantity: 1 }], payments: [{ method: 'cash', amount: '10.00', tendered: '10.00' }] })).body.id;
    }, 120_000);

    afterEach(() => { errors.length = 0; });

    it('no read logs an error, and each answers 200', async () => {
        const as = { Authorization: `Bearer ${tokens.sign(adminId)}` };
        const original = logger.error.bind(logger);
        (logger as { error: unknown }).error = (...args: unknown[]) => { errors.push(args); };
        const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Beirut' }).format(new Date());
        const reads = [
            '/branches', `/branches/${branchId}`, '/places', '/warehouse', '/categories', '/styles', `/styles/${styleId}`, '/skus', `/skus/${skuId}`, `/stock?branchId=${branchId}`, `/stock/overview`, `/stock/movements?branchId=${branchId}`,
            '/stock/adjustments', '/goods-receipts', '/suppliers', '/settings', '/cash-sessions', `/cash-sessions/current?branchId=${branchId}`, '/returns', `/returns/eligible?sale=${saleId}`, '/invoices', '/transfers', '/reorder-levels', '/replenishment/suggestions',
            `/reports/sales-summary?from=${today}&to=${today}`, `/reports/top-skus?from=${today}&to=${today}`, `/costs/profit?from=${today}&to=${today}`, `/costs/skus/${skuId}`, '/audit-events', '/users', '/permissions', `/sales/${saleId}`, `/sales?branchId=${branchId}&businessDate=${today}`, `/sales/history?branchId=${branchId}`, '/auth/me',
        ];
        const statuses: Record<string, number> = {};
        try {
            for (const path of reads) statuses[path] = (await request(app).get(path).set(as)).status;
        } finally { (logger as { error: unknown }).error = original; }
        const bad = Object.entries(statuses).filter(([, status]) => status >= 500);
        expect(bad, JSON.stringify(bad)).toEqual([]);
        expect(errors.map((e) => String(e[1] ?? e[0])), 'logged errors').toEqual([]);
        expect(Object.keys(statuses)).toHaveLength(reads.length);
    });
});
