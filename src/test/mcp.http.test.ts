import 'dotenv/config';
import { vi } from 'vitest';

vi.hoisted(() => {
    process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123456';
    process.env.AUTH_MODE = 'jwt';
});

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BitarApi, BitarApiError } from '../mcp/BitarApi';
import { app } from '../app';
import { prisma } from '../db';
import { UserRole } from '../models/User.model';
import { UserRepository } from '../repositories/UserRepository';
import { JwtTokenService } from '../services/JwtTokenService';
import { createUserWithPassword } from '../test-helpers/createUserWithPassword';
import { waitForDatabase } from '../test-helpers/waitForDatabase';

const disposable = process.env.TEST_DB_DISPOSABLE === '1';
const stamp = Date.now();
const short = String(stamp).slice(-8);
const tokens = new JwtTokenService(process.env.JWT_SECRET!);
const as = (id: string) => ({ Authorization: `Bearer ${tokens.sign(id)}` });
const key = () => `mcp-${randomUUID()}`;
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Beirut' }).format(new Date());
const EXPECTED_TOOLS = ['cash_drawers', 'list_branches', 'profit_report', 'reorder_suggestions', 'returns', 'sales_summary', 'stock_levels', 'top_products', 'transfers'];

// ---- the API client: it can only read, only what is on the list, and it never leaks the token
describe('the MCP API client', () => {
    const calls: { url: string; method: string }[] = [];
    const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    const fake = (handler: (url: URL, init: RequestInit) => Response): typeof fetch => (async (input: URL | string, init: RequestInit = {}) => {
        const url = new URL(String(input));
        calls.push({ url: url.pathname, method: init.method ?? 'GET' });
        return handler(url, init);
    }) as typeof fetch;
    const config = { baseUrl: 'http://api.test', email: 'm@x.test', password: 'secret-password' };

    it('reads only: GET, and only the paths on the list; anything else is refused before any request is made', async () => {
        calls.length = 0;
        const api = new BitarApi(config, fake((url) => (url.pathname === '/auth/login' ? reply({ token: 'T1' }) : reply([]))));
        for (const path of ['/users', '/sales', '/invoices', '/auth/login', '/audit-events', '/branches/abc', '/stock/adjustments', '/reports/../users', '/cash-sessions/abc/close']) {
            await expect(api.get(path), path).rejects.toMatchObject({ status: 403 });
        }
        expect(calls).toEqual([]);                                                                      // not even a login happened
        await api.get('/branches');
        expect(calls.map((c) => c.method).sort()).toEqual(['GET', 'POST']);                             // the only POST is the sign-in itself
        expect(calls.filter((c) => c.method === 'POST').map((c) => c.url)).toEqual(['/auth/login']);
    });

    it('signs in once, signs in again when the token expired, and says clearly what went wrong', async () => {
        calls.length = 0;
        let logins = 0, expire = false;
        const api = new BitarApi(config, fake((url, init) => {
            if (url.pathname === '/auth/login') { logins++; return reply({ token: `T${logins}` }); }
            if (expire && (init.headers as Record<string, string>).Authorization === 'Bearer T1') { expire = false; return reply({ message: 'expired' }, 401); }
            return reply({ ok: true });
        }));
        await api.get('/settings');
        await api.get('/settings');
        expect(logins).toBe(1);                                                                         // the token is kept: one sign-in for many reads
        expire = true;
        await api.get('/settings');                                                                     // the token expired: a 401, a new sign-in, the read works
        expect(logins).toBe(2);
        const denied = new BitarApi(config, fake((url) => (url.pathname === '/auth/login' ? reply({ token: 'T' }) : reply({ message: 'Missing permission: reports.financial' }, 403))));
        await expect(denied.get('/reports/sales-summary')).rejects.toThrow(/not allowed to read this/);
        const wrong = new BitarApi(config, fake(() => reply({ message: 'Invalid credentials' }, 401)));
        await expect(wrong.get('/branches')).rejects.toThrow(/BITAR_EMAIL and BITAR_PASSWORD/);
        const broken = new BitarApi(config, fake((url) => (url.pathname === '/auth/login' ? reply({ token: 'T' }) : reply({ message: 'boom' }, 500))));
        await expect(broken.get('/settings')).rejects.toBeInstanceOf(BitarApiError);
    });

    it('finds a branch by name, code or part of the name, and says what to do when there is none or several', async () => {
        const branches = [{ id: 'b1', code: 'HAM', name: 'Hamra', kind: 'branch' }, { id: 'b2', code: 'TRI', name: 'Tripoli', kind: 'branch' }, { id: 'b3', code: 'TRO', name: 'Troy Outlet', kind: 'branch' }];
        const api = new BitarApi(config, fake((url) => (url.pathname === '/auth/login' ? reply({ token: 'T' }) : reply(branches))));
        expect((await api.resolveBranch('hamra')).id).toBe('b1');
        expect((await api.resolveBranch('  TRI ')).id).toBe('b2');
        expect((await api.resolveBranch('b3')).id).toBe('b3');
        expect((await api.resolveBranch('ham')).id).toBe('b1');
        await expect(api.resolveBranch('tr')).rejects.toThrow(/matches several branches: Tripoli, Troy Outlet/);
        await expect(api.resolveBranch('Beirut')).rejects.toThrow(/No branch matches "Beirut". The branches are: Hamra, Tripoli, Troy Outlet/);
    });
});

// ---- the real MCP server, started the way Claude Desktop starts it, talking to the real API
describe.skipIf(!disposable)('the MCP server against the real API (real database)', () => {
    let server: http.Server;
    let baseUrl = '';
    let managerId = '', staffId = '', branchId = '';
    let manager: Client, staff: Client, stranger: Client;
    const managerEmail = `mcpmgr-${stamp}@bitar.test`, staffEmail = `mcpstaff-${stamp}@bitar.test`;
    const PASSWORD = 'Password#123';
    const api = async (path: string, userId: string) => (await fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${tokens.sign(userId)}` } })).json() as Promise<any>;

    const connect = async (email: string, password: string) => {
        const client = new Client({ name: 'test', version: '1.0.0' });
        await client.connect(new StdioClientTransport({ command: 'npx', args: ['tsx', 'src/mcp/server.ts'], env: { ...(process.env as Record<string, string>), BITAR_API_URL: baseUrl, BITAR_EMAIL: email, BITAR_PASSWORD: password } }));
        return client;
    };
    const call = async (client: Client, name: string, args: object = {}) => {
        const res: any = await client.callTool({ name, arguments: args });
        const text: string = res.content[0].text;
        return { isError: Boolean(res.isError), text, data: res.isError ? null : JSON.parse(text) };
    };

    beforeAll(async () => {
        await waitForDatabase(prisma);
        server = http.createServer(app);
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const make = async (email: string, role: UserRole) => (await createUserWithPassword(new UserRepository(prisma), { email, password: PASSWORD, fullName: `Test ${email.split('-')[0]}`, role }, null)).getId();
        const adminId = await make(`mcpadmin-${stamp}@bitar.test`, UserRole.ADMIN);
        managerId = await make(managerEmail, UserRole.MANAGER);
        staffId = await make(staffEmail, UserRole.EMPLOYEE);
        branchId = (await request(app).post('/branches').set(as(adminId)).send({ code: `MC${short}`, name: `Mcp Branch ${short}` })).body.id;
        for (const u of [managerId, staffId]) await request(app).put(`/users/${u}/branches/${branchId}`).set(as(adminId));
        const styleId = (await request(app).post('/styles').set(as(adminId)).send({ code: `MC${short}`, name: `Mcp Dress ${short}` })).body.id;
        const sku = (await request(app).post('/skus').set(as(adminId)).send({ styleId, skuCode: `MC${short}-1`, size: 'M', color: 'Grey', standardPrice: '40.00' })).body.id;
        await request(app).post('/stock/opening').set(as(adminId)).set('Idempotency-Key', key()).send({ branchId, lines: [{ skuId: sku, quantity: 50 }] });
        await request(app).put('/reorder-levels').set(as(adminId)).send({ branchId, skuId: sku, minQuantity: 60, targetQuantity: 80 });
        for (const quantity of [1, 1, 2]) {
            const total = (quantity * 40).toFixed(2);
            expect((await request(app).post('/sales').set(as(managerId)).set('Idempotency-Key', key()).send({ branchId, lines: [{ skuId: sku, quantity }], payments: [{ method: 'cash', amount: total, tendered: total }] })).status).toBe(201);
        }
        // on the road to the branch: 1 piece from another branch; a return waiting in custody; an open drawer
        const sender = (await request(app).post('/branches').set(as(adminId)).send({ code: `MD${short}`, name: `Mcp Sender ${short}` })).body.id;
        await request(app).put(`/users/${managerId}/branches/${sender}`).set(as(adminId));
        await request(app).post('/stock/opening').set(as(adminId)).set('Idempotency-Key', key()).send({ branchId: sender, lines: [{ skuId: sku, quantity: 5 }] });
        const transfer = (await request(app).post('/transfers').set(as(managerId)).set('Idempotency-Key', key()).send({ sourceBranchId: sender, destinationBranchId: branchId, lines: [{ skuId: sku, quantity: 1 }] })).body;
        expect((await request(app).post(`/transfers/${transfer.id}/dispatch`).set(as(managerId)).set('Idempotency-Key', key())).status).toBe(200);
        const sale = (await request(app).get(`/sales?branchId=${branchId}&businessDate=${today}`).set(as(managerId))).body.sales[0];
        const made = await request(app).post('/returns').set(as(managerId)).set('Idempotency-Key', key()).send({ saleId: sale.id, receivingBranchId: branchId, reason: 'Does not fit', lines: [{ skuId: sku, quantity: 1, condition: 'as_new' }] });
        expect(made.status, JSON.stringify(made.body)).toBe(201);
        expect((await request(app).post('/cash-sessions').set(as(managerId)).send({ branchId, openingCash: '50.00' })).status).toBe(201);
        manager = await connect(managerEmail, PASSWORD);
        staff = await connect(staffEmail, PASSWORD);
        stranger = await connect(managerEmail, 'not-the-password');
    }, 180_000);

    afterAll(async () => {
        await Promise.allSettled([manager?.close(), staff?.close(), stranger?.close()]);
        await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    });

    it('offers exactly the read-only tools and the weekly report prompt', async () => {
        const tools = (await manager.listTools()).tools;
        expect(tools.map((t) => t.name).sort()).toEqual(EXPECTED_TOOLS);
        for (const tool of tools) {
            expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
            expect(tool.annotations?.destructiveHint, tool.name).toBe(false);
            expect(tool.description?.length, tool.name).toBeGreaterThan(30);
        }
        const prompts = (await manager.listPrompts()).prompts;
        expect(prompts.map((p) => p.name)).toEqual(['weekly_report']);
        const prompt = await manager.getPrompt({ name: 'weekly_report', arguments: { from: '2026-11-03', to: '2026-11-09' } });
        const message = (prompt.messages[0].content as { text: string }).text;
        expect(message).toContain('2026-11-03 to 2026-11-09');
        expect(message).toMatch(/Best sellers/);
        expect(message).toMatch(/do not invent numbers/);
    });

    it('the sales summary is the numbers of the API: 160.00 over three sales, by branch, shop and online', async () => {
        const viaMcp = await call(manager, 'sales_summary', { from: today, to: today, branch: `Mcp Branch ${short}` });
        expect(viaMcp.isError, viaMcp.text).toBe(false);
        const direct = await api(`/reports/sales-summary?branchId=${branchId}&from=${today}&to=${today}`, managerId);
        expect(viaMcp.data.totals).toEqual(direct.totals);
        expect(viaMcp.data.totals).toMatchObject({ salesCount: 3, items: 4, revenue: '160.00', refunds: '0.00', netRevenue: '160.00', inStore: '160.00', socialMedia: '0.00' });
        expect(viaMcp.data.byBranch).toEqual([expect.objectContaining({ branch: `Mcp Branch ${short}`, revenue: '160.00', online: '0.00', cash: '160.00' })]);
        expect(viaMcp.data.byDay.find((d: { day: string }) => d.day === today).revenue).toBe('160.00');
        const noDates = await call(manager, 'sales_summary', { branch: 'mcp branch' });                                  // today, and a partial name
        expect(noDates.data.totals.revenue).toBe('160.00');
    });

    it('best sellers, profit, stock, what to reorder, transfers, drawers and returns all answer from the API', async () => {
        const top = await call(manager, 'top_products', { from: today, to: today, branch: `Mcp Branch ${short}`, limit: 5 });
        expect(top.data.products).toEqual([{ product: `Mcp Dress ${short} M Grey`, sku: `MC${short}-1`, pieces: 4, revenue: '160.00', sales: 3 }]);
        const profit = await call(manager, 'profit_report', { from: today, to: today, branch: `Mcp Branch ${short}` });
        expect(profit.data.totals).toMatchObject({ revenue: '160.00', salesCount: 3, refunds: '0.00' });
        expect(profit.data.byBranch[0].branch).toBe(`Mcp Branch ${short}`);
        const stock = await call(manager, 'stock_levels', { branch: `Mcp Branch ${short}`, search: `Mcp Dress ${short}` });
        expect(stock.data, JSON.stringify(stock.data)).toMatchObject({ branch: `Mcp Branch ${short}`, total: 1, products: [{ product: `Mcp Dress ${short} M Grey`, sku: `MC${short}-1`, forSale: 46, onHold: 0, onTheRoad: 1 }] });
        const reorder = await call(manager, 'reorder_suggestions', { branch: `Mcp Branch ${short}` });
        expect(reorder.data.count).toBe(1);
        expect(reorder.data.suggestions[0]).toMatchObject({ branch: `Mcp Branch ${short}`, sku: `MC${short}-1`, forSale: 46, onTheRoad: 1, minimum: 60, target: 80, suggested: 33 });       // 80 - (46 for sale + 1 on the road)
        expect(reorder.data.totalPiecesSuggested).toBe(33);
        const transfers = await call(manager, 'transfers', { branch: `Mcp Branch ${short}`, status: 'dispatched' });
        expect(transfers.isError, transfers.text).toBe(false);
        expect(transfers.data).toEqual([expect.objectContaining({ status: 'dispatched', from: `Mcp Sender ${short}`, to: `Mcp Branch ${short}`, pieces: expect.objectContaining({ requested: 1, dispatched: 1, onTheRoad: 1 }) })]);
        expect(transfers.data[0].supplyInvoice).toMatch(/^draft/);                                    // a transfer between branches has a supply invoice and a return invoice, both drafts
        expect(transfers.data[0].returnInvoice).toMatch(/^draft/);
        expect((await call(manager, 'transfers', { branch: `Mcp Branch ${short}`, status: 'received' })).data).toEqual([]);
        const drawers = await call(manager, 'cash_drawers', { branch: `Mcp Branch ${short}`, status: 'open' });
        expect(drawers.data).toEqual([expect.objectContaining({ branch: `Mcp Branch ${short}`, status: 'open', closedAt: null, difference: null, review: 'none' })]);
        expect((await call(manager, 'cash_drawers', { branch: `Mcp Branch ${short}`, review: 'flagged' })).data).toEqual([]);
        const returns = await call(manager, 'returns', { branch: `Mcp Branch ${short}`, status: 'in_custody' });
        expect(returns.data).toEqual([expect.objectContaining({ status: 'in_custody', receivedAt: `Mcp Branch ${short}`, pieces: 1, refund: null, refundStillToPay: null })]);
        expect((await call(manager, 'returns', { branch: `Mcp Branch ${short}`, status: 'approved' })).data).toEqual([]);
        expect((await call(manager, 'list_branches')).data.map((b: { name: string }) => b.name)).toContain(`Mcp Branch ${short}`);
    });

    it('a mistake is an answer, not a crash: an unknown branch lists the real ones, a bad date is refused, an employee is told they cannot read finances', async () => {
        const unknown = await call(manager, 'sales_summary', { branch: 'Atlantis' });
        expect(unknown.isError).toBe(true);
        expect(unknown.text).toMatch(/No branch matches "Atlantis". The branches are:.*Mcp Branch/);
        const badDate: any = await manager.callTool({ name: 'sales_summary', arguments: { from: 'yesterday' } }).catch((e: Error) => ({ thrown: e.message }));
        expect(JSON.stringify(badDate)).toMatch(/date|invalid|2026/i);
        const forbidden = await call(staff, 'sales_summary', { from: today, to: today });
        expect(forbidden.isError).toBe(true);
        expect(forbidden.text).toMatch(/not allowed to read this/);
        const wrong = await call(stranger, 'list_branches');
        expect(wrong.isError).toBe(true);
        expect(wrong.text).toMatch(/BITAR_EMAIL and BITAR_PASSWORD/);
    });

    it('the scope of the account is kept: a manager sees only their branches in the totals; nothing in any answer carries the token or the password', async () => {
        const all = await call(manager, 'sales_summary', { from: today, to: today });
        expect(all.data.byBranch.map((b: { branch: string }) => b.branch).sort()).toEqual([`Mcp Branch ${short}`, `Mcp Sender ${short}`]);       // the two this manager reaches, and no other branch of the business
        const everything = [(await call(manager, 'list_branches')).text, all.text, (await call(manager, 'stock_levels', { branch: `Mcp Branch ${short}` })).text, (await call(staff, 'sales_summary')).text].join('\n');
        expect(everything).not.toContain(PASSWORD);
        expect(everything).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./);                                      // no JWT
    });
});
