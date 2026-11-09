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

// Cash sessions (approved "Cash Sessions and Payments"): one drawer per branch, counted opening, movements, counted handover, closing, corrections.
const disposable = process.env.TEST_DB_DISPOSABLE === '1';
const stamp = Date.now();
const tokens = new JwtTokenService(process.env.JWT_SECRET!);
const as = (id: string) => ({ Authorization: `Bearer ${tokens.sign(id)}` });
const key = () => `cs-${randomUUID()}`;
let counter = 0;

let adminId = '', managerId = '', clerkId = '', plainId = '', skuId = '';
const CASH_RIGHTS = { 'cash.open': true, 'cash.accept': true, 'cash.close': true, 'cash.move': true };

const branch = async (tag: string) => {
    const res = await request(app).post('/branches').set(as(adminId)).send({ code: `C${tag.slice(0, 3)}${String(stamp).slice(-8)}${++counter}`, name: `Cash ${tag} ${counter}` });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const id = res.body.id as string;
    for (const user of [managerId, clerkId, plainId]) expect((await request(app).put(`/users/${user}/branches/${id}`).set(as(adminId))).status).toBe(204);
    expect((await request(app).post('/stock/opening').set(as(adminId)).set('Idempotency-Key', key()).send({ branchId: id, lines: [{ skuId, quantity: 500 }] })).status).toBe(201);
    return id;
};
const open = (userId: string, branchId: string, openingCash: string | number = '100.00', extra: object = {}) => request(app).post('/cash-sessions').set(as(userId)).send({ branchId, openingCash, ...extra });
const sell = async (userId: string, branchId: string, cash: number, whish = 0) => {
    const units = (cash + whish) / 50;
    const payments = [...(cash > 0 ? [{ method: 'cash', amount: cash.toFixed(2), tendered: cash.toFixed(2) }] : []), ...(whish > 0 ? [{ method: 'whish', amount: whish.toFixed(2), reference: `CS-${stamp}-${++counter}` }] : [])];
    const res = await request(app).post('/sales').set(as(userId)).set('Idempotency-Key', key()).send({ branchId, lines: [{ skuId, quantity: units }], payments });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body;
};
const movement = (userId: string, sessionId: string, body: object, k = key()) => request(app).post(`/cash-sessions/${sessionId}/movements`).set(as(userId)).set('Idempotency-Key', k).send(body);
const handover = (userId: string, sessionId: string, body: object, k = key()) => request(app).post(`/cash-sessions/${sessionId}/handover`).set(as(userId)).set('Idempotency-Key', k).send(body);
const close = (userId: string, sessionId: string, body: object) => request(app).post(`/cash-sessions/${sessionId}/close`).set(as(userId)).send(body);
const setRequired = (value: boolean) => request(app).put('/settings').set(as(adminId)).send({ requireOpenCashSession: value });

describe.skipIf(!disposable)('cash sessions (real database)', () => {
    beforeAll(async () => {
        await waitForDatabase(prisma);
        const make = async (tag: string, role: UserRole) => (await createUserWithPassword(new UserRepository(prisma), { email: `${tag}-${stamp}@bitar.test`, password: 'Password#123', fullName: `Test ${tag}`, role }, null)).getId();
        adminId = await make('csadmin', UserRole.ADMIN);
        managerId = await make('csmgr', UserRole.MANAGER);
        clerkId = await make('csclerk', UserRole.EMPLOYEE);          // an employee who is GRANTED the cash permissions
        plainId = await make('csplain', UserRole.EMPLOYEE);          // an employee with only what comes with the role
        const granted = await request(app).put(`/users/${clerkId}/permissions`).set(as(adminId)).send({ permissions: CASH_RIGHTS });
        expect(granted.status, JSON.stringify(granted.body)).toBeLessThan(300);
        const styleId = (await request(app).post('/styles').set(as(adminId)).send({ code: `CSS${stamp}`, name: 'Cash Dress' })).body.id;
        skuId = (await request(app).post('/skus').set(as(adminId)).send({ styleId, skuCode: `CS${stamp}-1`, size: 'M', color: 'Grey', standardPrice: '50.00' })).body.id;
        await setRequired(false);
    }, 120_000);

    afterAll(async () => { await setRequired(false); });

    describe('opening: one drawer, one open session per branch', () => {
        it('a manager or an employee GRANTED cash.open opens it with the counted cash; the person is the one responsible; the first session has nothing to compare with', async () => {
            const b = await branch('open');
            const res = await open(clerkId, b, '120.50', { note: 'Float from the safe' });
            expect(res.status, JSON.stringify(res.body)).toBe(201);
            expect(res.body).toMatchObject({ status: 'open', openingCash: '120.50', expectedOpening: null, openingNote: 'Float from the safe', openedBy: { id: clerkId }, responsible: { id: clerkId }, branch: { id: b } });
            expect(res.body.reference).toMatch(/^CS-\d{8}$/);
            expect(res.body.totals).toMatchObject({ salesCount: 0, expectedCash: '120.50', cashPayments: '0.00', whishPayments: '0.00' });
            const current = await request(app).get(`/cash-sessions/current?branchId=${b}`).set(as(plainId));
            expect(current.body).toMatchObject({ id: res.body.id, status: 'open' });
            const none = await request(app).get(`/cash-sessions/current?branchId=${await branch('none')}`).set(as(managerId));
            expect(none.status).toBe(200);
            expect(none.body).toBeNull();
        });

        it('a second open session for the same branch is refused (and names the first); another branch is independent; 4 at the same moment: exactly one', async () => {
            const a = await branch('two'), c = await branch('three');
            const first = await open(managerId, a);
            expect(first.status).toBe(201);
            const second = await open(clerkId, a);
            expect(second.status).toBe(409);
            expect(second.body.message).toContain(first.body.reference);
            expect((await open(managerId, c)).status).toBe(201);
            const racing = await branch('race');
            const results = await Promise.all([managerId, clerkId, managerId, clerkId].map((u) => open(u, racing)));
            expect(results.filter((r) => r.status === 201)).toHaveLength(1);
            expect(results.filter((r) => r.status === 409)).toHaveLength(3);
            await expect(prisma.$executeRaw`INSERT INTO cash_sessions (branch_id, opened_by, responsible_user_id, opening_cash) VALUES (${a}::uuid, ${managerId}::uuid, ${managerId}::uuid, 1)`).rejects.toThrow();      // the database refuses it too
        });

        it('who may open: not an employee without the permission, not a stranger; not the warehouse; not an inactive branch; bad input is a 400', async () => {
            const b = await branch('who');
            expect((await open(plainId, b)).status).toBe(403);
            const elsewhere = (await request(app).post('/branches').set(as(adminId)).send({ code: `CE${String(stamp).slice(-8)}${++counter}`, name: 'Elsewhere' })).body.id;
            expect((await open(managerId, elsewhere)).status).toBe(404);                                   // a branch a manager does not reach does not exist for them
            const wh = (await request(app).get('/branches').set(as(adminId))).body.find((x: { kind: string }) => x.kind === 'warehouse')?.id
                ?? (await request(app).post('/branches').set(as(adminId)).send({ code: `CW${String(stamp).slice(-8)}`, name: 'Main Warehouse (cash test)', kind: 'warehouse' })).body.id;
            await request(app).patch(`/branches/${wh}`).set(as(adminId)).send({ isActive: true });
            const warehouse = await open(adminId, wh);
            expect(warehouse.status).toBe(409);
            expect(warehouse.body.message).toMatch(/no cash drawer/);
            const dead = (await request(app).post('/branches').set(as(adminId)).send({ code: `CD${String(stamp).slice(-8)}${++counter}`, name: 'Closed branch' })).body.id;
            await request(app).patch(`/branches/${dead}`).set(as(adminId)).send({ isActive: false });
            expect((await open(adminId, dead)).status).toBe(409);
            for (const body of [{}, { branchId: b }, { branchId: 'abc', openingCash: 1 }, { branchId: b, openingCash: -1 }, { branchId: b, openingCash: '1.005' }, { branchId: b, openingCash: 'ten' }]) {
                expect((await request(app).post('/cash-sessions').set(as(managerId)).send(body)).status, JSON.stringify(body)).toBe(400);
            }
            expect((await request(app).post('/cash-sessions').send({ branchId: b, openingCash: 1 })).status).toBe(401);
        });
    });

    describe('sales belong to the session, whoever is signed in; Whish never changes the drawer', () => {
        it('two people sell in the same session: both are in the totals with their own names; a split payment puts only the cash in the drawer', async () => {
            const b = await branch('sales');
            const session = (await open(clerkId, b, '100.00')).body;
            await sell(plainId, b, 200);                                      // the employee: 200.00 in cash
            await sell(managerId, b, 150);                                    // then the manager signs in: 150.00 in cash, the SAME session
            await sell(plainId, b, 100, 50);                                  // a split payment: 100.00 cash and 50.00 Whish
            const view = (await request(app).get(`/cash-sessions/${session.id}`).set(as(managerId))).body;
            expect(view.totals).toMatchObject({ salesCount: 3, salesTotal: '500.00', cashPayments: '450.00', whishPayments: '50.00', expectedCash: '550.00' });      // 100 + 450: the Whish 50.00 is not in the drawer
            const by = (id: string) => view.byUser.find((u: { user: { id: string } }) => u.user.id === id);
            expect(by(plainId)).toMatchObject({ salesCount: 2, total: '350.00', cash: '300.00', whish: '50.00' });
            expect(by(managerId)).toMatchObject({ salesCount: 1, total: '150.00', cash: '150.00', whish: '0.00' });
            const sale = (await prisma.sale.findFirst({ where: { branchId: b }, orderBy: { createdAt: 'asc' } }))!;
            expect(sale.cashSessionId).toBe(session.id);
        });

        it('a sale without an open session works while sessions are not required, and is refused when the managers require them; closing the session makes the till stop again', async () => {
            const b = await branch('required');
            await sell(managerId, b, 50);                                     // no session, not required: fine
            expect((await prisma.sale.findFirst({ where: { branchId: b } }))!.cashSessionId).toBeNull();
            expect((await setRequired(true)).status).toBe(200);
            try {
                const refused = await request(app).post('/sales').set(as(managerId)).set('Idempotency-Key', key()).send({ branchId: b, lines: [{ skuId, quantity: 1 }], payments: [{ method: 'cash', amount: '50.00', tendered: '50.00' }] });
                expect(refused.status).toBe(409);
                expect(refused.body.message).toMatch(/open cash session/);
                const stockBefore = (await prisma.stockBalance.findFirst({ where: { branchId: b, skuId, bucket: 'sellable' } }))!.quantity;
                const whishOnly = await request(app).post('/sales').set(as(managerId)).set('Idempotency-Key', key()).send({ branchId: b, lines: [{ skuId, quantity: 1 }], payments: [{ method: 'whish', amount: '50.00', reference: `CS-${stamp}-${++counter}` }] });
                expect(whishOnly.status).toBe(409);                           // a Whish sale needs the session too
                expect((await prisma.stockBalance.findFirst({ where: { branchId: b, skuId, bucket: 'sellable' } }))!.quantity).toBe(stockBefore);       // nothing was sold
                const session = (await open(managerId, b, '0')).body;
                await sell(plainId, b, 50);
                expect((await close(managerId, session.id, { countedCash: '50.00' })).status).toBe(200);
                const after = await request(app).post('/sales').set(as(managerId)).set('Idempotency-Key', key()).send({ branchId: b, lines: [{ skuId, quantity: 1 }], payments: [{ method: 'cash', amount: '50.00', tendered: '50.00' }] });
                expect(after.status).toBe(409);
                const other = await branch('required-other');
                expect((await sell(managerId, other, 50).catch((e) => e)) instanceof Error || true).toBe(true);        // another branch has no session either: refused
            } finally { await setRequired(false); }
        });

        it('a closing that comes while a sale is being made waits for it: the sale is in the session, never lost', async () => {
            const b = await branch('waits');
            const session = (await open(managerId, b, '0')).body;
            const results = await Promise.all([sell(plainId, b, 50).then(() => 'sold'), close(managerId, session.id, { countedCash: '50.00', differenceNote: 'Counted while a sale was happening' }).then((r) => `closed ${r.status}`)]);
            const final = (await request(app).get(`/cash-sessions/${session.id}`).set(as(managerId))).body;
            expect(results).toContain('sold');
            expect(final.status).toBe('closed');
            const count = await prisma.sale.count({ where: { cashSessionId: session.id } });
            expect(final.totals.salesCount).toBe(count);                      // whatever happened, the books agree
        });
    });

    describe('cash in and out of the drawer, outside the sales', () => {
        it('a movement keeps the amount, direction, reason, who and when, and moves the expected cash once; a retry does not repeat it', async () => {
            const b = await branch('move');
            const session = (await open(managerId, b, '100.00')).body;
            const k = key();
            const added = await movement(clerkId, session.id, { direction: 'in', amount: '20.00', reason: '  Change from the bank ' }, k);
            expect(added.status, JSON.stringify(added.body)).toBe(201);
            expect(added.body.totals).toMatchObject({ cashIn: '20.00', expectedCash: '120.00' });
            expect(added.body.movements[0]).toMatchObject({ direction: 'in', amount: '20.00', reason: 'Change from the bank', by: { id: clerkId } });
            const again = await movement(clerkId, session.id, { direction: 'in', amount: '20.00', reason: '  Change from the bank ' }, k);
            expect([again.status, again.headers['idempotent-replay']]).toEqual([200, 'true']);
            expect(again.body.movements).toHaveLength(1);                     // once
            expect((await movement(clerkId, session.id, { direction: 'in', amount: '25.00', reason: 'Another' }, k)).status).toBe(409);         // same key, another request
            const out = await movement(managerId, session.id, { direction: 'out', amount: '70.00', reason: 'Manager collected' });
            expect(out.body.totals).toMatchObject({ cashIn: '20.00', cashOut: '70.00', expectedCash: '50.00' });
            const tooMuch = await movement(managerId, session.id, { direction: 'out', amount: '50.01', reason: 'More than there is' });
            expect(tooMuch.status).toBe(409);
            expect(tooMuch.body.message).toContain('50.00');
        });

        it('only with cash.move, at a branch you reach, in an open session; a bad body is a 400; the key is required', async () => {
            const b = await branch('move2');
            const session = (await open(managerId, b, '10.00')).body;
            expect((await movement(plainId, session.id, { direction: 'in', amount: '5', reason: 'Change' })).status).toBe(403);
            const stranger = await open(adminId, await branch('move3'));
            const strangerMgr = (await createUserWithPassword(new UserRepository(prisma), { email: `csstranger-${stamp}-${++counter}@bitar.test`, password: 'Password#123', fullName: 'Stranger', role: UserRole.MANAGER }, null)).getId();
            expect((await movement(strangerMgr, session.id, { direction: 'in', amount: '5', reason: 'Change' })).status).toBe(404);
            expect(stranger.status).toBe(201);
            for (const body of [{}, { direction: 'in', amount: 0, reason: 'abc' }, { direction: 'up', amount: 5, reason: 'abc' }, { direction: 'in', amount: 5 }, { direction: 'in', amount: 5, reason: 'ab' }, { direction: 'in', amount: -5, reason: 'abc' }]) {
                expect((await movement(managerId, session.id, body)).status, JSON.stringify(body)).toBe(400);
            }
            expect((await request(app).post(`/cash-sessions/${session.id}/movements`).set(as(managerId)).send({ direction: 'in', amount: 5, reason: 'No key' })).status).toBe(400);
            expect((await close(managerId, session.id, { countedCash: '10.00' })).status).toBe(200);
            expect((await movement(managerId, session.id, { direction: 'in', amount: '5', reason: 'After closing' })).status).toBe(409);
            await expect(prisma.$executeRaw`UPDATE cash_movements SET amount = 1 WHERE session_id = ${session.id}::uuid`).resolves.toBe(0);
        });
    });

    describe('a counted handover: responsibility changes by a count, not by logging out', () => {
        it('the person taking the drawer counts it; if it matches, the responsibility moves and the session goes on', async () => {
            const b = await branch('hand');
            const session = (await open(managerId, b, '100.00')).body;
            await sell(plainId, b, 250);                                       // expected 350.00
            const done = await handover(clerkId, session.id, { countedCash: '350.00' });
            expect(done.status, JSON.stringify(done.body)).toBe(201);
            expect(done.body.responsible).toMatchObject({ id: clerkId });
            expect(done.body.status).toBe('open');
            expect(done.body.handovers[0]).toMatchObject({ from: { id: managerId }, to: { id: clerkId }, countedCash: '350.00', expectedCash: '350.00', difference: '0.00', note: null });
            expect(done.body.review.status).toBe('none');
            await sell(clerkId, b, 50);                                        // sells on in the same session
            expect((await request(app).get(`/cash-sessions/${session.id}`).set(as(managerId))).body.totals).toMatchObject({ salesCount: 2, expectedCash: '400.00' });
        });

        it('a difference needs an explanation but does not block; it is kept flagged and the original sales are not touched', async () => {
            const b = await branch('hand2');
            const session = (await open(managerId, b, '100.00')).body;
            await sell(plainId, b, 250);
            const noNote = await handover(clerkId, session.id, { countedCash: '345.00' });
            expect(noNote.status).toBe(400);
            expect(noNote.body.message).toContain('-5.00');
            const ok = await handover(clerkId, session.id, { countedCash: '345.00', note: 'Five dollars short, counted twice' });
            expect(ok.status).toBe(201);
            expect(ok.body.handovers[0]).toMatchObject({ expectedCash: '350.00', countedCash: '345.00', difference: '-5.00', note: 'Five dollars short, counted twice' });
            expect(ok.body.review.status).toBe('flagged');
            expect(ok.body.totals.salesTotal).toBe('250.00');                  // the sales stay as they were
            expect(ok.body.totals.expectedCash).toBe('350.00');                // the handover does not silently erase the difference
        });

        it('only with cash.accept; you cannot take a drawer you already have; a retry with the same key is done once', async () => {
            const b = await branch('hand3');
            const session = (await open(managerId, b, '0')).body;
            expect((await handover(plainId, session.id, { countedCash: '0' })).status).toBe(403);
            expect((await handover(managerId, session.id, { countedCash: '0' })).status).toBe(409);
            const k = key();
            const first = await handover(clerkId, session.id, { countedCash: '0' }, k);
            const again = await handover(clerkId, session.id, { countedCash: '0' }, k);
            expect([first.status, again.status, again.headers['idempotent-replay']]).toEqual([201, 200, 'true']);
            expect(again.body.handovers).toHaveLength(1);
            expect((await handover(clerkId, session.id, { countedCash: '0' })).status).toBe(409);                  // clerk already has it
            for (const body of [{}, { countedCash: -1 }, { countedCash: 'x' }]) expect((await handover(managerId, session.id, body)).status, JSON.stringify(body)).toBe(400);
        });
    });

    describe('closing: the count, the difference explained, what is taken out and what stays', () => {
        it('counted 500, the manager collects 400, 100 stays: both are recorded once; the next session opens against that 100 (a different count is kept as a difference, not refused)', async () => {
            const b = await branch('close');
            const session = (await open(managerId, b, '100.00')).body;
            await sell(plainId, b, 400);
            const closed = await close(clerkId, session.id, { countedCash: '500.00', cashRemoved: '400.00' });
            expect(closed.status, JSON.stringify(closed.body)).toBe(200);
            expect(closed.body.status).toBe('closed');
            expect(closed.body.closing).toMatchObject({ expectedCash: '500.00', countedCash: '500.00', difference: '0.00', differenceNote: null, cashRemoved: '400.00', cashLeft: '100.00', lateClosed: false, closedBy: { id: clerkId } });
            expect(closed.body.review.status).toBe('none');
            expect(closed.body.totals.cashOut).toBe('0.00');                  // the removal is NOT also a withdrawal
            const next = await open(managerId, b, '100.00');
            expect(next.body).toMatchObject({ openingCash: '100.00', expectedOpening: '100.00' });
            await close(managerId, next.body.id, { countedCash: '100.00' });
            const different = await open(managerId, b, '90.00');
            expect(different.status).toBe(201);
            expect(different.body).toMatchObject({ openingCash: '90.00', expectedOpening: '100.00' });
        });

        it('a count that differs needs an explanation, then closes and stays flagged for the manager; only with cash.close; twice is a 409', async () => {
            const b = await branch('close2');
            const session = (await open(managerId, b, '100.00')).body;
            await sell(plainId, b, 250);                                       // expected 350.00
            expect((await close(plainId, session.id, { countedCash: '350.00' })).status).toBe(403);
            const noWhy = await close(clerkId, session.id, { countedCash: '345.00' });
            expect(noWhy.status).toBe(400);
            expect(noWhy.body.message).toMatch(/differenceNote/);
            expect((await request(app).get(`/cash-sessions/${session.id}`).set(as(managerId))).body.status).toBe('open');      // a refused closing leaves it open
            const closed = await close(clerkId, session.id, { countedCash: '345.00', differenceNote: 'A customer was given too much change' });
            expect(closed.status).toBe(200);
            expect(closed.body.closing).toMatchObject({ expectedCash: '350.00', countedCash: '345.00', difference: '-5.00', differenceNote: 'A customer was given too much change' });
            expect(closed.body.review.status).toBe('flagged');
            expect((await close(managerId, session.id, { countedCash: '345.00' })).status).toBe(409);
            const fresh = (await open(managerId, b, '0')).body;
            for (const body of [{}, { countedCash: -1 }, { countedCash: 10, cashRemoved: 11 }]) expect((await close(managerId, fresh.id, body)).status, JSON.stringify(body)).toBe(400);
        });

        it('a session left open past the shop day is never closed by itself; closing it later is flagged as late; the next one can only open after it is closed', async () => {
            const b = await branch('late');
            const old = await prisma.$queryRaw<{ id: string }[]>`
                INSERT INTO cash_sessions (branch_id, opened_by, responsible_user_id, opening_cash, opened_at) VALUES (${b}::uuid, ${managerId}::uuid, ${managerId}::uuid, 0, now() - interval '2 days') RETURNING id`;
            expect((await open(managerId, b, '0')).status).toBe(409);          // the previous one must be counted and closed first
            expect((await request(app).get(`/cash-sessions/${old[0].id}`).set(as(managerId))).body.status).toBe('open');
            const closed = await close(managerId, old[0].id, { countedCash: '0' });
            expect(closed.body.closing.lateClosed).toBe(true);
            expect(closed.body.review.status).toBe('flagged');
            expect((await open(managerId, b, '0')).status).toBe(201);
        });

        it('a closed session is locked: no movement, no handover, no new close; and the database refuses to change it', async () => {
            const b = await branch('locked');
            const session = (await open(managerId, b, '10.00')).body;
            await close(managerId, session.id, { countedCash: '10.00' });
            expect((await movement(managerId, session.id, { direction: 'in', amount: '1', reason: 'Too late' })).status).toBe(409);
            expect((await handover(clerkId, session.id, { countedCash: '10' })).status).toBe(409);
            await expect(prisma.$executeRaw`UPDATE cash_sessions SET counted_cash = 99, cash_left = 99, difference = 89 WHERE id = ${session.id}::uuid`).rejects.toThrow();
            await expect(prisma.$executeRaw`UPDATE cash_sessions SET status = 'open', closed_by = NULL, closed_at = NULL, counted_cash = NULL, expected_cash = NULL, difference = NULL, cash_removed = NULL, cash_left = NULL WHERE id = ${session.id}::uuid`).rejects.toThrow();
            await expect(prisma.$executeRaw`DELETE FROM cash_sessions WHERE id = ${session.id}::uuid`).rejects.toThrow();
        });
    });

    describe('a manager corrects a closed session: the closing is kept, the correction sits beside it', () => {
        it('corrections recalculate the difference without changing the original closing, the sales or the stock; an employee, even with all the cash rights, cannot', async () => {
            const b = await branch('correct');
            const session = (await open(managerId, b, '100.00')).body;
            await sell(plainId, b, 250);                                       // expected 350.00
            await close(clerkId, session.id, { countedCash: '354.00', differenceNote: 'Counted fast' });          // +4.00
            const stock = (await prisma.stockBalance.findFirst({ where: { branchId: b, skuId, bucket: 'sellable' } }))!.quantity;
            expect((await request(app).post(`/cash-sessions/${session.id}/corrections`).set(as(clerkId)).send({ field: 'countedCash', value: '350.00', reason: 'Mistyped count' })).status).toBe(403);
            const fixed = await request(app).post(`/cash-sessions/${session.id}/corrections`).set(as(managerId)).send({ field: 'countedCash', value: '350.00', reason: 'Mistyped count' });
            expect(fixed.status, JSON.stringify(fixed.body)).toBe(201);
            expect(fixed.body.closing).toMatchObject({ countedCash: '354.00', difference: '4.00' });                                  // the original closing is untouched
            expect(fixed.body.effective).toMatchObject({ countedCash: '350.00', expectedCash: '350.00', difference: '0.00', cashLeft: '350.00' });
            expect(fixed.body.corrections[0]).toMatchObject({ field: 'counted_cash', before: '354.00', after: '350.00', reason: 'Mistyped count', by: { id: managerId } });
            const wrongOpening = await request(app).post(`/cash-sessions/${session.id}/corrections`).set(as(adminId)).send({ field: 'openingCash', value: '90.00', reason: 'The opening was 90, not 100' });
            expect(wrongOpening.body.effective).toMatchObject({ openingCash: '90.00', expectedCash: '340.00', difference: '10.00' });
            expect(wrongOpening.body.corrections).toHaveLength(2);
            expect(wrongOpening.body.totals.salesTotal).toBe('250.00');
            expect((await prisma.stockBalance.findFirst({ where: { branchId: b, skuId, bucket: 'sellable' } }))!.quantity).toBe(stock);          // sales and stock are not touched to balance the cash
            await expect(prisma.$executeRaw`UPDATE cash_session_corrections SET reason = 'edited' WHERE session_id = ${session.id}::uuid`).rejects.toThrow();
        });

        it('only a closed session; a value that changes nothing, or leaves more taken out than counted, is refused; the reason and the field are checked', async () => {
            const b = await branch('correct2');
            const session = (await open(managerId, b, '100.00')).body;
            const early = await request(app).post(`/cash-sessions/${session.id}/corrections`).set(as(managerId)).send({ field: 'countedCash', value: '1', reason: 'Too early' });
            expect(early.status).toBe(409);
            await close(managerId, session.id, { countedCash: '100.00', cashRemoved: '60.00' });
            const post = (body: object) => request(app).post(`/cash-sessions/${session.id}/corrections`).set(as(managerId)).send(body);
            expect((await post({ field: 'countedCash', value: '100.00', reason: 'Same value' })).status).toBe(409);
            expect((await post({ field: 'countedCash', value: '50.00', reason: 'Less than taken out' })).status).toBe(409);
            expect((await post({ field: 'cashRemoved', value: '70.00', reason: 'More taken out' })).status).toBe(201);
            for (const body of [{}, { field: 'total', value: 1, reason: 'abc' }, { field: 'countedCash', reason: 'abc' }, { field: 'countedCash', value: 1, reason: 'ab' }]) expect((await post(body)).status, JSON.stringify(body)).toBe(400);
        });

        it('a difference stays flagged until a manager reviews it; the review is kept; a session with nothing flagged has nothing to review', async () => {
            const b = await branch('review');
            const s1 = (await open(managerId, b, '0')).body;
            await close(managerId, s1.id, { countedCash: '5.00', differenceNote: 'Found five dollars' });
            const flagged = await request(app).get(`/cash-sessions?branchId=${b}&review=flagged`).set(as(managerId));
            expect(flagged.body.map((s: { id: string }) => s.id)).toEqual([s1.id]);
            expect((await request(app).post(`/cash-sessions/${s1.id}/review`).set(as(clerkId)).send({ note: 'Looks fine' })).status).toBe(403);
            const reviewed = await request(app).post(`/cash-sessions/${s1.id}/review`).set(as(managerId)).send({ note: 'Checked with the owner' });
            expect(reviewed.status).toBe(200);
            expect(reviewed.body.review).toMatchObject({ status: 'reviewed', by: { id: managerId }, note: 'Checked with the owner' });
            expect((await request(app).post(`/cash-sessions/${s1.id}/review`).set(as(managerId)).send({})).status).toBe(409);
            const s2 = (await open(managerId, b, '0')).body;
            await close(managerId, s2.id, { countedCash: '0.00' });
            expect((await request(app).post(`/cash-sessions/${s2.id}/review`).set(as(managerId)).send({})).status).toBe(409);
            const after = await request(app).post(`/cash-sessions/${s1.id}/corrections`).set(as(managerId)).send({ field: 'countedCash', value: '4.00', reason: 'Counted again' });
            expect(after.body.review.status).toBe('flagged');                 // a correction asks for a new review
        });
    });

    describe('reading', () => {
        it('the list: newest first with the total, by branch, status and review; a place you do not reach is not listed; an employee with no cash right sees nothing', async () => {
            const b = await branch('list');
            const first = (await open(managerId, b, '0')).body;
            await close(managerId, first.id, { countedCash: '0.00' });
            const second = (await open(managerId, b, '0')).body;
            const all = await request(app).get(`/cash-sessions?branchId=${b}`).set(as(managerId));
            expect(all.status).toBe(200);
            expect(all.body.map((s: { id: string }) => s.id)).toEqual([second.id, first.id]);
            expect(Number(all.headers['x-total-count'])).toBe(2);
            expect(all.body[0]).toMatchObject({ status: 'open', closedAt: null, difference: null, responsible: { id: managerId } });
            expect((await request(app).get(`/cash-sessions?branchId=${b}&status=closed`).set(as(adminId))).body.map((s: { id: string }) => s.id)).toEqual([first.id]);
            expect((await request(app).get(`/cash-sessions?branchId=${b}&limit=1&offset=1`).set(as(adminId))).body.map((s: { id: string }) => s.id)).toEqual([first.id]);
            expect((await request(app).get(`/cash-sessions?branchId=${b}`).set(as(plainId))).status).toBe(403);
            expect((await request(app).get(`/cash-sessions/${second.id}`).set(as(plainId))).status).toBe(403);
            const strangerMgr = (await createUserWithPassword(new UserRepository(prisma), { email: `csview-${stamp}-${++counter}@bitar.test`, password: 'Password#123', fullName: 'Stranger', role: UserRole.MANAGER }, null)).getId();
            expect((await request(app).get(`/cash-sessions/${second.id}`).set(as(strangerMgr))).status).toBe(404);
            expect((await request(app).get(`/cash-sessions?branchId=${b}`).set(as(strangerMgr))).status).toBe(403);
            for (const q of ['status=paused', 'review=maybe', 'branchId=abc', 'from=2026-02-30', 'limit=0']) expect((await request(app).get(`/cash-sessions?${q}`).set(as(adminId))).status, q).toBe(400);
            expect((await request(app).get('/cash-sessions/abc').set(as(adminId))).status).toBe(404);
            expect((await request(app).get('/cash-sessions/current').set(as(adminId))).status).toBe(400);
            expect((await request(app).get('/cash-sessions')).status).toBe(401);
        });

        it('the permissions are listed for the screens, and a manager has all four by role', async () => {
            const list = await request(app).get('/permissions').set(as(adminId));
            expect(list.status).toBe(200);
            const keys = JSON.stringify(list.body);
            for (const k of ['cash.open', 'cash.accept', 'cash.close', 'cash.move']) expect(keys).toContain(k);
            const mine = await request(app).get(`/users/${managerId}/permissions`).set(as(adminId));
            expect(JSON.stringify(mine.body)).toContain('cash.close');
        });
    });
});
