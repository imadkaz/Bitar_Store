// npm run seed:demo -- --yes
// REALISTIC DEMO DATA for the Bitar Fashion presentation: 3 branches and the warehouse, 24 products, suppliers and goods received at cost, stock sent to the branches
// (with a damaged piece on hold), a transfer between two branches (two invoices), ten days of sales (cash, Whish, pounds, discounts, social media), open and closed
// cash drawers (one with a difference to review), returns in every state (refund paid in cash, in custody, rejected, an exchange), and reorder levels so that suggestions appear.
//
// EVERYTHING goes through the real API rules (stock, costs, invoices, drawers, returns), so the numbers are consistent; only the DATES of the past sales are set back.
// It refuses to run in production, needs --yes, and refuses a database that already has the demo (unless --force). A remote database (Neon) needs --allow-remote.
import 'dotenv/config';

const args = new Set(process.argv.slice(2));
const PASSWORD = 'Demo#2026pass';

async function main() {
    if (process.env.NODE_ENV === 'production') throw new Error('seed:demo must never run with NODE_ENV=production');
    if (!args.has('--yes')) throw new Error('Add --yes to confirm. It writes demo data to the database in DATABASE_URL.');
    const url = process.env.DATABASE_URL ?? '';
    const host = (() => { try { return new URL(url).host; } catch { return '(unreadable DATABASE_URL)'; } })();
    console.log(`Database: ${host}`);
    if (/neon\.tech/i.test(host) && !args.has('--allow-remote')) throw new Error('This is a remote (Neon) database. Add --allow-remote only if you are SURE this is the demo database.');
    if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is not set');
    process.env.AUTH_MODE = process.env.AUTH_MODE ?? 'jwt';

    const { default: request } = await import('supertest');
    const { randomUUID } = await import('node:crypto');
    const { app } = await import('../src/app');
    const { prisma } = await import('../src/db');
    const { UserRole } = await import('../src/models/User.model');
    const { UserRepository } = await import('../src/repositories/UserRepository');
    const { JwtTokenService } = await import('../src/services/JwtTokenService');
    const { createUserWithPassword } = await import('../src/test-helpers/createUserWithPassword');
    const tokens = new JwtTokenService(process.env.JWT_SECRET);

    const marker = await prisma.$queryRaw<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM styles WHERE code LIKE 'DEMO-%'`;
    if (marker[0].n > 0 && !args.has('--force')) throw new Error('The demo data is already there (styles DEMO-*). Use --force to add a second copy.');

    // ---- helpers
    type Res = { status: number; body: any };
    const call = async (method: 'get' | 'post' | 'put' | 'patch', path: string, as: string, body?: object, expect: number[] = [200, 201, 204]): Promise<Res> => {
        let req = (request(app) as any)[method](path).set('Authorization', `Bearer ${tokens.sign(as)}`);
        if (method === 'post') req = req.set('Idempotency-Key', `demo-${randomUUID()}`);
        const res = body === undefined ? await req : await req.send(body);
        if (!expect.includes(res.status)) throw new Error(`${method.toUpperCase()} ${path} -> ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
        return { status: res.status, body: res.body };
    };
    const usd = (cents: number) => (cents / 100).toFixed(2);
    let seed = 20261110;
    const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const pick = <T,>(items: T[]): T => items[Math.floor(rnd() * items.length)];
    const run = String(Date.now()).slice(-6);

    // ---- people
    const users = new UserRepository(prisma);
    const person = async (email: string, fullName: string, role: any): Promise<string> => {
        const existing = await users.findByEmail(email);
        if (existing) return existing.getId();
        return (await createUserWithPassword(users, { email, password: PASSWORD, fullName, role }, null)).getId();
    };
    const adminId = await person('admin@bitar.demo', 'Demo Admin', UserRole.ADMIN);
    const managerId = await person('manager@bitar.demo', 'Karim Haddad (manager)', UserRole.MANAGER);
    const cashierId = await person('cashier@bitar.demo', 'Sara Nassar (cashier)', UserRole.EMPLOYEE);
    await call('put', `/users/${cashierId}/permissions`, adminId, { permissions: { 'returns.create': true, 'transfers.receive': true, 'cash.open': true, 'cash.accept': true, 'cash.close': true, 'cash.move': true } });

    // ---- places
    const branchesNow = (await call('get', '/branches', adminId)).body as { id: string; kind: string }[];
    let warehouseId = branchesNow.find((b) => b.kind === 'warehouse')?.id;
    if (!warehouseId) warehouseId = (await call('post', '/branches', adminId, { code: `DEMO-WH${run}`, name: 'Main Warehouse', kind: 'warehouse' })).body.id;
    await call('patch', `/branches/${warehouseId}`, adminId, { isActive: true });
    const mkBranch = async (code: string, name: string) => (await call('post', '/branches', adminId, { code: `${code}${run}`, name })).body.id as string;
    const hamra = await mkBranch('DEMO-HAM', 'Hamra'), tripoli = await mkBranch('DEMO-TRI', 'Tripoli'), saida = await mkBranch('DEMO-SAI', 'Saida');
    for (const b of [hamra, tripoli, saida, warehouseId]) await call('put', `/users/${managerId}/branches/${b}`, adminId);
    await call('put', `/users/${cashierId}/branches/${hamra}`, adminId);
    await call('put', '/settings', adminId, { exchangeRateUsdLbp: 89_500, lbpRoundingStep: 1_000, returnPeriodDays: 14, requireOpenCashSession: false });

    // ---- catalog: 8 styles x 3 sizes
    const styles = [
        { code: 'SW', name: 'Silk Wrap Dress', color: 'Ivory', price: 8900, supplier: 0, weight: 5 }, { code: 'LS', name: 'Linen Shirt Dress', color: 'Sage', price: 6400, supplier: 0, weight: 3 },
        { code: 'EG', name: 'Evening Gown', color: 'Black', price: 14900, supplier: 1, weight: 1 }, { code: 'SM', name: 'Summer Maxi', color: 'Coral', price: 7200, supplier: 1, weight: 5 },
        { code: 'PM', name: 'Pleated Midi Skirt', color: 'Navy', price: 4800, supplier: 1, weight: 2 }, { code: 'DJ', name: 'Denim Jacket', color: 'Indigo', price: 8500, supplier: 2, weight: 2 },
        { code: 'CB', name: 'Cotton Blouse', color: 'White', price: 3900, supplier: 0, weight: 4 }, { code: 'WT', name: 'Wide Leg Trousers', color: 'Camel', price: 5600, supplier: 2, weight: 3 },
    ];
    const skus: { id: string; code: string; style: string; size: string; price: number; cost: number; supplier: number; weight: number }[] = [];
    for (const s of styles) {
        const styleId = (await call('post', '/styles', adminId, { code: `DEMO-${s.code}`, name: s.name })).body.id;
        for (const size of ['S', 'M', 'L']) {
            const code = `DEMO-${s.code}-${size}${run}`;
            const id = (await call('post', '/skus', adminId, { styleId, skuCode: code, size, color: s.color, standardPrice: usd(s.price) })).body.id as string;
            skus.push({ id, code, style: s.name, size, price: s.price, cost: Math.round(s.price * (0.5 + rnd() * 0.08) / 50) * 50, supplier: s.supplier, weight: s.weight * (size === 'M' ? 1.4 : 1) });
        }
    }
    const supplierIds: string[] = [];
    for (const [name, phone] of [['Atelier Beyrouth Textiles', '+961 1 345 678'], ['Lina Fashion Wholesale', '+961 3 221 009'], ['Cedar Denim Co', '+961 70 555 123']]) {
        supplierIds.push((await call('post', '/suppliers', managerId, { name: `${name} ${run}`, phone })).body.id);
    }
    for (let s = 0; s < 3; s++) {
        await call('post', '/goods-receipts', adminId, { supplierId: supplierIds[s], supplierInvoiceNumber: `INV-${run}-${s + 1}`, lines: skus.filter((k) => k.supplier === s).map((k) => ({ skuId: k.id, quantity: 40, unitCost: usd(k.cost) })) });
    }

    // ---- stock to the branches (the warehouse sends, the manager receives; one damaged piece stays on hold)
    const stock = new Map<string, Map<string, number>>([[hamra, new Map()], [tripoli, new Map()], [saida, new Map()]]);
    const send = async (to: string, qty: number, only?: typeof skus, damagedSku?: string) => {
        const list = only ?? skus;
        const t = (await call('post', '/transfers', adminId, { sourceBranchId: warehouseId, destinationBranchId: to, lines: list.map((k) => ({ skuId: k.id, quantity: qty })) })).body;
        await call('post', `/transfers/${t.id}/dispatch`, adminId, { expectedAt: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Beirut' }).format(new Date(Date.now() + 86_400_000)) });
        await call('post', `/transfers/${t.id}/receive`, managerId, { note: damagedSku ? 'One piece with a loose seam, kept apart' : 'Counted, all good', lines: list.map((k) => ({ skuId: k.id, accepted: k.id === damagedSku ? qty - 1 : qty, ...(k.id === damagedSku ? { damaged: 1 } : {}) })) });
        for (const k of list) stock.get(to)!.set(k.id, k.id === damagedSku ? qty - 1 : qty);
        return t.id as string;
    };
    const hamraTransfer = await send(hamra, 14, undefined, skus[0].id);
    await send(tripoli, 10);
    await send(saida, 8, skus.filter((_, i) => i % 2 === 0));
    // two supply invoices are drafts at cost: the manager finalizes the one to Hamra
    for (const inv of (await call('get', `/invoices?transferId=${hamraTransfer}`, adminId)).body as { id: string; status: string }[]) if (inv.status === 'draft') await call('post', `/invoices/${inv.id}/finalize`, adminId);
    // between two branches: Hamra sends 4 pieces of two products to Tripoli (a return invoice and a supply invoice are raised)
    const side = skus.filter((k) => k.style === 'Silk Wrap Dress' || k.style === 'Summer Maxi').slice(0, 2);
    const bt = (await call('post', '/transfers', managerId, { sourceBranchId: hamra, destinationBranchId: tripoli, lines: side.map((k) => ({ skuId: k.id, quantity: 4 })) })).body;
    await call('post', `/transfers/${bt.id}/dispatch`, managerId, {});
    await call('post', `/transfers/${bt.id}/receive`, managerId, { lines: side.map((k) => ({ skuId: k.id, accepted: 4 })) });
    for (const k of side) { stock.get(hamra)!.set(k.id, stock.get(hamra)!.get(k.id)! - 4); stock.get(tripoli)!.set(k.id, stock.get(tripoli)!.get(k.id)! + 4); }

    // ---- ten days of sales
    let n = 0;
    const sell = async (branch: string, dayOffset: number, seller: string): Promise<{ id: string; reference: string; total: string } | null> => {
        const have = stock.get(branch)!;
        const lines: { sku: (typeof skus)[number]; qty: number; override?: number }[] = [];
        for (let i = 0, count = 1 + Math.floor(rnd() * 3); i < count; i++) {
            const pool = skus.filter((k) => (have.get(k.id) ?? 0) > 3 && !lines.some((l) => l.sku.id === k.id));
            if (pool.length === 0) break;
            const total = pool.reduce((s, k) => s + k.weight, 0);
            let roll = rnd() * total, chosen = pool[0];
            for (const k of pool) { roll -= k.weight; if (roll <= 0) { chosen = k; break; } }
            lines.push({ sku: chosen, qty: rnd() < 0.8 ? 1 : 2, override: rnd() < 0.08 && seller === managerId ? Math.round(chosen.price * 0.9 / 100) * 100 : undefined });
        }
        if (lines.length === 0) return null;
        const totalCents = lines.reduce((s, l) => s + l.qty * (l.override ?? l.sku.price), 0);
        const roll = rnd();
        const social = roll > 0.9;
        let payments: object[];
        if (social || roll > 0.7) payments = [{ method: 'whish', amount: usd(totalCents), reference: `DEMO-${run}-${++n}` }];
        else if (roll > 0.6 && totalCents >= 4000) payments = [{ method: 'cash', currency: 'LBP', amount: usd(totalCents) }];
        else if (roll > 0.5 && totalCents >= 4000) { const cashPart = Math.floor(totalCents / 200) * 100; payments = [{ method: 'cash', amount: usd(cashPart), tendered: usd(cashPart) }, { method: 'whish', amount: usd(totalCents - cashPart), reference: `DEMO-${run}-${++n}` }]; }
        else { const tendered = Math.ceil(totalCents / 500) * 500; payments = [{ method: 'cash', amount: usd(totalCents), tendered: usd(tendered) }]; }
        const res = await call('post', '/sales', seller, {
            branchId: branch, ...(social ? { channel: 'social_media', socialPlatform: pick(['instagram', 'whatsapp']) } : {}),
            lines: lines.map((l) => ({ skuId: l.sku.id, quantity: l.qty, ...(l.override ? { discount: { type: 'override', unitPrice: usd(l.override), reason: 'Loyalty customer' } } : {}) })), payments,
        });
        for (const l of lines) have.set(l.sku.id, (have.get(l.sku.id) ?? 0) - l.qty);
        if (dayOffset > 0) {
            const hour = 10 + Math.floor(rnd() * 9);
            await prisma.$executeRaw`UPDATE sales SET business_date = business_date - ${dayOffset}::int, sold_at = (date_trunc('day', sold_at) - ${dayOffset}::int * interval '1 day') + ${hour}::int * interval '1 hour' + ${Math.floor(rnd() * 59)}::int * interval '1 minute' WHERE id = ${res.body.id}::uuid`;
        }
        return res.body;
    };
    const history: { id: string; branch: string; day: number }[] = [];
    for (let day = 9; day >= 1; day--) {
        for (const [branch, base, seller] of [[hamra, 6, cashierId], [tripoli, 4, managerId], [saida, 3, managerId]] as const) {
            const count = base + Math.floor(rnd() * 3) - (day === 1 || day === 8 ? 1 : 0);
            for (let i = 0; i < count; i++) {
                const made = await sell(branch, day, branch === hamra && rnd() < 0.5 ? managerId : seller);
                if (made) history.push({ id: made.id, branch, day });
            }
        }
    }

    // ---- reorder levels: popular products run low, so suggestions appear
    for (const branch of [hamra, tripoli, saida]) {
        for (const k of skus) await call('put', '/reorder-levels', adminId, { branchId: branch, skuId: k.id, minQuantity: 6, targetQuantity: 14 });
    }

    // ---- today: the Hamra drawer (open, with a handover) and the Tripoli drawer (closed with a difference to review)
    const hamraSession = (await call('post', '/cash-sessions', cashierId, { branchId: hamra, openingCash: '150.00', note: 'Float from the safe' })).body;
    for (let i = 0; i < 5; i++) await sell(hamra, 0, cashierId);
    await call('post', `/cash-sessions/${hamraSession.id}/movements`, managerId, { direction: 'in', amount: '20.00', reason: 'Change from the bank' });
    const beforeHandover = (await call('get', `/cash-sessions/${hamraSession.id}`, managerId)).body;
    await call('post', `/cash-sessions/${hamraSession.id}/handover`, managerId, { countedCash: beforeHandover.totals.expectedCash });
    for (let i = 0; i < 2; i++) await sell(hamra, 0, managerId);

    const triSession = (await call('post', '/cash-sessions', managerId, { branchId: tripoli, openingCash: '100.00' })).body;
    for (let i = 0; i < 4; i++) await sell(tripoli, 0, managerId);
    const triView = (await call('get', `/cash-sessions/${triSession.id}`, managerId)).body;
    const expected = Math.round(Number(triView.totals.expectedCash) * 100);
    await call('post', `/cash-sessions/${triSession.id}/close`, managerId, { countedCash: usd(expected - 500), cashRemoved: usd(Math.max(0, expected - 500 - 10000)), differenceNote: 'Five dollars short at the count, a customer was given too much change' });

    // ---- returns in every state, from sales of the last days (one made at Tripoli and returned at Hamra)
    const oneLine = async (saleId: string) => {
        const v = (await call('get', `/returns/eligible?sale=${saleId}`, managerId)).body;
        return { sale: v.sale as { id: string }, line: v.lines.find((l: { returnable: number }) => l.returnable > 0) as { skuId: string; returnable: number } };
    };
    const old = history.filter((h) => h.day >= 2 && h.day <= 6);
    const receive = async (saleId: string, at: string) => {
        const { sale, line } = await oneLine(saleId);
        return (await call('post', '/returns', cashierId, { saleId: sale.id, receivingBranchId: at, reason: pick(['Does not fit', 'Changed her mind', 'Color different from the photo']), lines: [{ skuId: line.skuId, quantity: 1, condition: 'as_new' }] })).body;
    };
    const r1 = await receive(old.find((h) => h.branch === tripoli)!.id, hamra);                         // bought at Tripoli, returned at Hamra: approved, refunded in cash from the open drawer
    await call('post', `/returns/${r1.id}/approve`, managerId, {});
    const refundDue = (await call('get', `/returns/${r1.id}`, managerId)).body.refund.total;
    await call('post', `/returns/${r1.id}/refunds`, managerId, { method: 'cash', amount: refundDue, recipient: 'Customer at the counter' });
    await receive(old.filter((h) => h.branch === hamra)[1].id, hamra);                                   // waiting for the manager's decision
    const r3 = await receive(old.filter((h) => h.branch === hamra)[2].id, hamra);                        // rejected, to be handed back
    await call('post', `/returns/${r3.id}/reject`, managerId, { reason: 'Worn and washed' });
    const r4 = await receive(old.filter((h) => h.branch === hamra)[3].id, hamra);                        // an exchange: approved, the replacement sold, the net recorded
    await call('post', `/returns/${r4.id}/approve`, managerId, {});
    const swap = await sell(hamra, 0, cashierId);
    if (swap) await call('post', `/returns/${r4.id}/exchange`, managerId, { saleId: swap.id });

    // ---- an invoice for a customer (Arabic name), final
    const invoiced = history.filter((h) => h.branch === hamra)[0];
    await call('post', '/invoices', managerId, { saleId: invoiced.id, customerName: 'ريما الخوري', customerPhone: '+961 3 456 789' });       // the invoice of a sale is final when it is made

    // ---- the summary
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Beirut' }).format(new Date());
    const from = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Beirut' }).format(new Date(Date.now() - 9 * 86_400_000));
    const summary = (await call('get', `/reports/sales-summary?from=${from}&to=${today}`, managerId)).body;
    const profit = (await call('get', `/costs/profit?from=${from}&to=${today}`, managerId)).body;
    const top = (await call('get', `/reports/top-skus?from=${from}&to=${today}&limit=3`, managerId)).body;
    const suggestions = (await call('get', '/replenishment/suggestions', managerId)).body;
    console.log('\n=== DEMO DATA READY ===');
    console.log(`Branches: Hamra, Tripoli, Saida + the warehouse. Products: ${skus.length}. Sales (10 days): ${summary.totals.salesCount}.`);
    console.log(`Revenue ${summary.totals.revenue} - refunds ${summary.totals.refunds} = net ${summary.totals.netRevenue} | online ${summary.totals.socialMedia} | Whish ${summary.totals.whish}`);
    console.log(`Profit (known cost) ${profit.totals.profit} -> net of returns ${profit.totals.netProfit} | unknown-cost sales ${profit.totals.unknownCostRevenue}`);
    console.log('Top sellers:', top.rows.map((r: { sku: { code: string }; quantity: number }) => `${r.sku.code} x${r.quantity}`).join(', '));
    console.log(`Reorder suggestions: ${suggestions.suggestions.length} (to fill the branches back up to their targets)`);
    console.log('Drawers: Hamra open (handover done), Tripoli closed with a -5.00 difference to review, Saida none.');
    console.log('Returns: 1 refunded in cash, 1 in custody, 1 rejected, 1 exchange (net recorded).');
    console.log(`\nLogins (password ${PASSWORD}):\n  admin@bitar.demo (technical)   manager@bitar.demo (all branches)   cashier@bitar.demo (Hamra)`);
    console.log('\nWhen the demo is over: disable these accounts (scripts: disable_test_users.sql, adapted to @bitar.demo).');
    await prisma.$disconnect();
}

main().catch((error) => { console.error(`\nSEED FAILED: ${error instanceof Error ? error.message : error}`); process.exit(1); });
