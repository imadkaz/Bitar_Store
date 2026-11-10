// Bitar Fashion MCP server (READ-ONLY, stdio). It lets an assistant such as Claude answer questions about the business and write reports,
// by calling the SAME API the web app uses, with the permissions and the branch scope of the account in the environment.
//   BITAR_API_URL   the API (default http://localhost:3000)
//   BITAR_EMAIL     the account the assistant signs in with (a manager)
//   BITAR_PASSWORD  its password
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { BitarApi, BitarApiError } from './BitarApi';

const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });
const failure = (error: unknown) => ({ isError: true, content: [{ type: 'text' as const, text: error instanceof BitarApiError ? error.message : `Something went wrong: ${error instanceof Error ? error.message : 'unknown error'}` }] });
const guard = <A,>(run: (args: A) => Promise<unknown>) => async (args: A) => { try { return text(await run(args)); } catch (error) { return failure(error); } };

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date like 2026-11-10').describe('A date, YYYY-MM-DD (the shop day, Beirut time)');
const branchArg = z.string().min(1).describe('A branch name or code, like "Hamra"');
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

export function buildServer(api: BitarApi): McpServer {
    const server = new McpServer({ name: 'bitar-fashion', version: '1.0.0' });
    const branchId = async (name?: string) => (name ? (await api.resolveBranch(name)).id : undefined);
    const names = async () => new Map((await api.branches()).map((b) => [b.id, b.name]));

    server.registerTool('list_branches', { title: 'List branches', description: 'The shops and the warehouse of Bitar Fashion that this account can see.', annotations: READ_ONLY },
        guard(async () => (await api.branches()).map((b) => ({ name: b.name, code: b.code, kind: b.kind }))));

    server.registerTool('sales_summary', {
        title: 'Sales summary',
        description: 'Revenue, refunds and net revenue of the sales over a period: the total of all branches, each branch, each day, and the split between the shop (inStore) and online (socialMedia), cash and Whish. Without dates it covers today.',
        inputSchema: { from: day.optional(), to: day.optional(), branch: branchArg.optional() }, annotations: READ_ONLY,
    }, guard(async ({ from, to, branch }) => {
        const { body } = await api.get<any>('/reports/sales-summary', { from, to, branchId: await branchId(branch) });
        return { period: { from: body.from, to: body.to }, totals: body.totals, byBranch: body.byBranch.map((b: any) => ({ branch: b.branch.name, salesCount: b.salesCount, items: b.items, revenue: b.revenue, refunds: b.refunds, netRevenue: b.netRevenue, inStore: b.inStore, online: b.socialMedia, cash: b.cash, whish: b.whish })), byDay: body.byDay };
    }));

    server.registerTool('top_products', {
        title: 'Best sellers',
        description: 'The products (sku) that sold the most pieces over a period, with their revenue. Without dates it covers today.',
        inputSchema: { from: day.optional(), to: day.optional(), branch: branchArg.optional(), limit: z.number().int().min(1).max(50).optional().describe('How many, 10 by default') }, annotations: READ_ONLY,
    }, guard(async ({ from, to, branch, limit }) => {
        const { body } = await api.get<any>('/reports/top-skus', { from, to, branchId: await branchId(branch), limit: limit ?? 10 });
        return { period: { from: body.from, to: body.to }, products: body.rows.map((r: any) => ({ product: `${r.sku.styleName} ${r.sku.size} ${r.sku.color}`, sku: r.sku.code, pieces: r.quantity, revenue: r.revenue, sales: r.salesCount })) };
    }));

    server.registerTool('profit_report', {
        title: 'Profit report',
        description: 'Revenue, cost and profit per branch and in total, on the cost kept on the day of each sale; refunds of returns are taken off (netRevenue, netProfit). Sales of unknown cost are shown apart (unknownCostRevenue), never guessed. Managers only.',
        inputSchema: { from: day.optional(), to: day.optional(), branch: branchArg.optional() }, annotations: READ_ONLY,
    }, guard(async ({ from, to, branch }) => {
        const { body } = await api.get<any>('/costs/profit', { from, to, branchId: await branchId(branch) });
        const by = await names();
        return { period: { from: body.from, to: body.to }, totals: body.totals, byBranch: body.byBranch.map((b: any) => ({ branch: by.get(b.branchId) ?? b.branchId, ...b, branchId: undefined })) };
    }));

    server.registerTool('stock_levels', {
        title: 'Stock levels',
        description: 'What a branch has of each product: for sale, on hold (not for sale: damaged or returned goods waiting for a decision) and on the road. Optionally only the products that match a search.',
        inputSchema: { branch: branchArg, search: z.string().optional().describe('Part of a product name or code'), limit: z.number().int().min(1).max(100).optional() }, annotations: READ_ONLY,
    }, guard(async ({ branch, search, limit }) => {
        const place = await api.resolveBranch(branch);
        const { body, headers } = await api.get<any[]>('/stock', { branchId: place.id, search, limit: limit ?? 30 });
        return { branch: place.name, shown: body.length, total: Number(headers.get('x-total-count') ?? body.length), products: body.map((s: any) => ({ product: `${s.sku.style?.name ?? ''} ${s.sku.size} ${s.sku.color}`.trim(), sku: s.sku.skuCode, forSale: s.sellable, onHold: s.nonSellable, onTheRoad: s.inTransit })) };
    }));

    server.registerTool('reorder_suggestions', {
        title: 'What to reorder',
        description: 'What each branch should receive from the warehouse to be back at its target stock (products below their minimum), with how much the warehouse can actually give.',
        inputSchema: { branch: branchArg.optional() }, annotations: READ_ONLY,
    }, guard(async ({ branch }) => {
        const { body } = await api.get<any>('/replenishment/suggestions', { branchId: await branchId(branch) });
        const rows = body.suggestions.map((s: any) => ({ branch: s.branch.name, product: `${s.sku.styleName} ${s.sku.size} ${s.sku.color}`, sku: s.sku.code, forSale: s.sellable, onTheRoad: s.inTransit, minimum: s.minQuantity, target: s.targetQuantity, suggested: s.suggested, warehouseHas: s.warehouseSellable, canSend: s.fillable }));
        return { count: rows.length, totalPiecesSuggested: rows.reduce((n: number, r: any) => n + r.suggested, 0), suggestions: rows.slice(0, 60), note: rows.length > 60 ? `Showing 60 of ${rows.length}: ask for one branch to see the rest.` : undefined };
    }));

    server.registerTool('transfers', {
        title: 'Transfers',
        description: 'Stock transfers between the warehouse and the branches, newest first. Status: draft, dispatched (on the road), partially_received, received or closed.',
        inputSchema: { status: z.enum(['draft', 'dispatched', 'partially_received', 'received', 'closed']).optional(), branch: branchArg.optional(), limit: z.number().int().min(1).max(50).optional() }, annotations: READ_ONLY,
    }, guard(async ({ status, branch, limit }) => {
        const { body } = await api.get<any[]>('/transfers', { status, branchId: await branchId(branch), limit: limit ?? 15 });
        return body.map((t) => ({ reference: t.reference, status: t.status, from: t.from.name, to: t.to.name, expectedAt: t.expectedAt, pieces: t.totals, supplyInvoice: t.supplyInvoice ? `${t.supplyInvoice.reference ?? 'draft'} (${t.supplyInvoice.total})` : null, returnInvoice: t.returnInvoice ? `${t.returnInvoice.reference ?? 'draft'} (${t.returnInvoice.total})` : null }));
    }));

    server.registerTool('cash_drawers', {
        title: 'Cash drawers',
        description: 'Cash sessions (the drawers) of the branches: open or closed, and whether a difference is waiting for a manager to review. Use review="flagged" to see only those that need attention.',
        inputSchema: { branch: branchArg.optional(), status: z.enum(['open', 'closed']).optional(), review: z.enum(['flagged', 'reviewed', 'none']).optional(), limit: z.number().int().min(1).max(30).optional() }, annotations: READ_ONLY,
    }, guard(async ({ branch, status, review, limit }) => {
        const { body } = await api.get<any[]>('/cash-sessions', { branchId: await branchId(branch), status, review, limit: limit ?? 10 });
        return body.map((s) => ({ reference: s.reference, branch: s.branch.name, status: s.status, openedBy: s.openedBy.name, openedAt: s.openedAt, closedAt: s.closedAt, difference: s.difference, late: s.lateClosed, review: s.reviewStatus }));
    }));

    server.registerTool('returns', {
        title: 'Customer returns',
        description: 'Customer returns: in_custody (waiting for a manager), approved (refund owed or paid), rejected, handed_back. Shows the refund still to pay.',
        inputSchema: { status: z.enum(['in_custody', 'approved', 'rejected', 'handed_back']).optional(), branch: branchArg.optional(), from: day.optional(), to: day.optional(), limit: z.number().int().min(1).max(50).optional() }, annotations: READ_ONLY,
    }, guard(async ({ status, branch, from, to, limit }) => {
        const { body } = await api.get<any[]>('/returns', { status, branchId: await branchId(branch), from, to, limit: limit ?? 15 });
        return body.map((r) => ({ reference: r.reference, status: r.status, sale: r.saleReference, receivedAt: r.receivingBranch.name, date: r.receivedAt, pieces: r.units, refund: r.refundTotal, refundStillToPay: r.refundOutstanding }));
    }));

    // a ready-made report: one click asks for the whole picture
    server.registerPrompt('weekly_report', {
        title: 'Weekly business report',
        description: 'A report on the last 7 days: sales per branch and online, best sellers, profit, what to reorder, and what needs the owner\'s attention.',
        argsSchema: { from: day.optional(), to: day.optional() },
    }, ({ from, to }) => ({
        messages: [{ role: 'user' as const, content: { type: 'text' as const, text:
            `Write a clear weekly report for the owners of Bitar Fashion${from && to ? ` for ${from} to ${to}` : ' for the last 7 days (use today and the 6 days before it)'}. Use the Bitar tools; do not invent numbers.\n` +
            '1. Sales: total revenue, net of refunds, per branch, and shop versus online. Say which branch and which day were best.\n' +
            '2. Best sellers: the top 5 products.\n' +
            '3. Profit: profit and net profit, and mention any sales of unknown cost.\n' +
            '4. Stock: what to reorder (by branch, with what the warehouse can send), and anything on hold.\n' +
            '5. Needs attention: cash drawers with a difference to review, returns waiting for a decision, transfers still on the road.\n' +
            'Finish with three short recommendations. Amounts are in US dollars.' } }],
    }));

    return server;
}

async function main() {
    const baseUrl = (process.env.BITAR_API_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
    const email = process.env.BITAR_EMAIL, password = process.env.BITAR_PASSWORD;
    if (!email || !password) { console.error('Set BITAR_EMAIL and BITAR_PASSWORD (a manager account). BITAR_API_URL defaults to http://localhost:3000.'); process.exit(1); }
    const server = buildServer(new BitarApi({ baseUrl, email, password }));
    await server.connect(new StdioServerTransport());
    console.error(`Bitar MCP server ready (read-only) for ${email} on ${baseUrl}`);      // stderr only: stdout belongs to the protocol
}

if (require.main === module) main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
