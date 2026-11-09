import { Prisma, PrismaClient } from '../generated/prisma/client';
import { lineTotalCents, UpdateInvoiceRequest } from '../models/Invoice.model';
import { formatCents } from '../models/Money';
import { ConflictError } from '../utils/exeptions/ConflictError';
import { NotFoundError } from '../utils/exeptions/NotFoundError';
import { ValidationError } from '../utils/exeptions/ValidationError';
import { writeAudit } from './audit';
import { IInvoiceWriter } from './interfaces/IInvoiceWriter';

const TX = { maxWait: 10_000, timeout: 30_000 };
const cents = (decimal: string): number => Math.round(Number(decimal) * 100);
type Authorize = (issuerBranchId: string, recipientBranchId: string | null) => void;

interface Locked { id: string; kind: 'b2b' | 'b2c'; status: 'draft' | 'final' | 'void'; reference: string | null; issuer_branch_id: string; recipient_branch_id: string | null; currency: string }

export class InvoiceWriter implements IInvoiceWriter {
    constructor(private readonly prisma: PrismaClient) {}

    // two people making the invoice of the same thing at once: the database lets only one live invoice in
    private async run<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
        try {
            return await this.prisma.$transaction(work, TX);
        } catch (error) {
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002' && JSON.stringify(error.meta ?? {}).includes('live')) {
                throw new ConflictError('This already has an invoice');
            }
            throw error;
        }
    }

    private async lock(tx: Prisma.TransactionClient, invoiceId: string, authorize: Authorize): Promise<Locked> {
        const rows = await tx.$queryRaw<Locked[]>`SELECT id, kind, status, reference, issuer_branch_id, recipient_branch_id, currency FROM invoices WHERE id = ${invoiceId}::uuid FOR UPDATE`;
        if (rows.length === 0) throw new NotFoundError('Invoice not found');
        authorize(rows[0].issuer_branch_id, rows[0].recipient_branch_id);
        return rows[0];
    }

    // which invoices a transfer needs, from where it goes and where it comes from
    private invoiceKindsFor(sourceKind: string, destinationKind: string): ('b2b' | 'b2b_return')[] {
        if (sourceKind === 'warehouse') return ['b2b'];
        if (destinationKind === 'warehouse') return ['b2b_return'];
        return ['b2b_return', 'b2b'];          // branch to branch: the sending branch returns to the warehouse, the warehouse sells to the receiving branch
    }

    async raiseDraftsForTransfer(transferId: string, actorId: string): Promise<string[]> {
        const rows = await this.prisma.$queryRaw<{ source_kind: string; destination_kind: string }[]>`
            SELECT sb.kind AS source_kind, db.kind AS destination_kind FROM transfers t JOIN branches sb ON sb.id = t.source_branch_id JOIN branches db ON db.id = t.destination_branch_id WHERE t.id = ${transferId}::uuid`;
        if (rows.length === 0) return [];
        const raised: string[] = [];
        for (const kind of this.invoiceKindsFor(rows[0].source_kind, rows[0].destination_kind)) {
            try { raised.push(await this.createFromTransfer(transferId, actorId, null, () => undefined, kind)); } catch { /* it exists already, or it can be raised by hand */ }
        }
        return raised;
    }

    async createFromTransfer(transferId: string, actorId: string, note: string | null, authorize: (sourceBranchId: string, destinationBranchId: string, issuerBranchId: string) => void, invoiceKind: 'b2b' | 'b2b_return' | null = null): Promise<string> {
        return this.run(async (tx) => {
            const transfers = await tx.$queryRaw<{ id: string; reference: string; status: string; source_branch_id: string; destination_branch_id: string; source_name: string; source_kind: string; destination_name: string; destination_kind: string }[]>`
                SELECT t.id, t.reference, t.status, t.source_branch_id, t.destination_branch_id, sb.name AS source_name, sb.kind AS source_kind, db.name AS destination_name, db.kind AS destination_kind
                FROM transfers t JOIN branches sb ON sb.id = t.source_branch_id JOIN branches db ON db.id = t.destination_branch_id
                WHERE t.id = ${transferId}::uuid FOR SHARE OF t`;
            if (transfers.length === 0) throw new NotFoundError('Transfer not found');
            const transfer = transfers[0];
            const allowed = this.invoiceKindsFor(transfer.source_kind, transfer.destination_kind);
            const kind = invoiceKind ?? allowed[0];
            if (!allowed.includes(kind)) throw new ConflictError(`A transfer from a ${transfer.source_kind} to a ${transfer.destination_kind} has no ${kind === 'b2b' ? 'supply' : 'return'} invoice`);

            // the warehouse is on one side of the invoice: it issues the supply invoice, and receives the return invoice
            const warehouse = transfer.source_kind === 'warehouse' ? { id: transfer.source_branch_id, name: transfer.source_name }
                : transfer.destination_kind === 'warehouse' ? { id: transfer.destination_branch_id, name: transfer.destination_name }
                : (await tx.$queryRaw<{ id: string; name: string }[]>`SELECT id, name FROM branches WHERE kind = 'warehouse'`)[0];
            if (!warehouse) throw new ConflictError('There is no warehouse yet');
            const issuer = kind === 'b2b' ? warehouse : { id: transfer.source_branch_id, name: transfer.source_name };
            const recipient = kind === 'b2b' ? { id: transfer.destination_branch_id, name: transfer.destination_name } : warehouse;
            authorize(transfer.source_branch_id, transfer.destination_branch_id, issuer.id);
            if (transfer.status === 'draft' || transfer.status === 'cancelled') throw new ConflictError(`A ${transfer.status} transfer has nothing sent: make the invoice after it is sent`);

            const existing = await tx.$queryRaw<{ id: string; status: string; reference: string | null }[]>`SELECT id, status, reference FROM invoices WHERE transfer_id = ${transferId}::uuid AND kind = ${kind} AND status <> 'void'`;
            if (existing.length > 0) {
                const live = existing[0];
                throw new ConflictError(live.status === 'draft'
                    ? `This transfer already has a draft ${kind === 'b2b' ? 'supply' : 'return'} invoice (id ${live.id}): edit it, finalize it or delete it`
                    : `This transfer already has the invoice ${live.reference} (id ${live.id}). Void it first to make another`);
            }

            // what leaves is priced at what the warehouse paid for it (the average cost kept at the warehouse), whoever sends it
            const lines = await tx.$queryRaw<{ sku_id: string; sku_code: string; style_name: string; size: string; color: string; quantity: number; price: string | null; currency: string }[]>`
                SELECT tl.sku_id, k.sku_code, st.name AS style_name, k.size, k.color, tl.dispatched_qty AS quantity, COALESCE(sc.avg_unit_cost, cc.unit_cost)::text AS price, k.currency
                FROM transfer_lines tl JOIN skus k ON k.id = tl.sku_id JOIN styles st ON st.id = k.style_id
                LEFT JOIN stock_costs sc ON sc.sku_id = tl.sku_id AND sc.branch_id = ${warehouse.id}::uuid
                LEFT JOIN catalog_costs cc ON cc.sku_id = tl.sku_id
                WHERE tl.transfer_id = ${transferId}::uuid AND tl.dispatched_qty > 0 ORDER BY k.sku_code`;
            if (lines.length === 0) throw new ConflictError('Nothing was sent in this transfer');
            const currency = lines[0].currency;
            if (lines.some((l) => l.currency !== currency)) throw new ConflictError('The products of this transfer are priced in different currencies');

            const prepared = lines.map((l, i) => ({ lineNo: i + 1, skuId: l.sku_id, skuCode: l.sku_code, description: `${l.style_name}, ${l.size}, ${l.color}`, quantity: l.quantity, unitCents: l.price === null ? 0 : cents(l.price), priceSource: l.price === null ? 'missing' as const : 'cost' as const }));
            const subtotal = prepared.reduce((sum, l) => sum + lineTotalCents(l.quantity, l.unitCents), 0);
            const created = await tx.invoice.create({
                data: {
                    kind, status: 'draft', transferId, issuerBranchId: issuer.id, issuerName: issuer.name, recipientBranchId: recipient.id,
                    recipientName: recipient.name, currency, subtotal: formatCents(subtotal), discountTotal: '0.00', total: formatCents(subtotal), note, issuedBy: actorId,
                    lines: { create: prepared.map((l) => ({ lineNo: l.lineNo, skuId: l.skuId, skuCode: l.skuCode, description: l.description, quantity: l.quantity, unitPrice: formatCents(l.unitCents), discountAmount: '0.00', lineTotal: formatCents(lineTotalCents(l.quantity, l.unitCents)), priceSource: l.priceSource })) },
                },
            });
            await writeAudit(tx, { actorId, action: 'invoice.create', entityType: 'invoice', entityId: created.id, branchId: issuer.id, details: { kind, transfer: transfer.reference, lines: prepared.length, total: formatCents(subtotal), missingCost: prepared.filter((l) => l.priceSource === 'missing').length } });
            return created.id;
        });
    }

    async createFromSale(saleId: string, actorId: string, extra: { customerName: string | null; customerPhone: string | null; note: string | null }, authorize: (branchId: string) => void): Promise<string> {
        return this.run(async (tx) => {
            const sales = await tx.$queryRaw<{ id: string; reference: string; status: string; branch_id: string; branch_name: string; currency: string; subtotal: string; discount: string; total: string; exchange_rate: number | null; total_lbp: string | null }[]>`
                SELECT s.id, s.reference, s.status, s.branch_id, b.name AS branch_name, s.currency, s.subtotal_standard::text AS subtotal, s.total_discount::text AS discount, s.total::text AS total, s.exchange_rate, s.total_lbp::text AS total_lbp
                FROM sales s JOIN branches b ON b.id = s.branch_id WHERE s.id = ${saleId}::uuid FOR SHARE OF s`;
            if (sales.length === 0) throw new NotFoundError('Sale not found');
            const sale = sales[0];
            authorize(sale.branch_id);
            if (sale.status !== 'completed' && sale.status !== 'partially_returned') throw new ConflictError(`A ${sale.status} sale cannot be invoiced`);

            const existing = await tx.$queryRaw<{ id: string; reference: string | null }[]>`SELECT id, reference FROM invoices WHERE sale_id = ${saleId}::uuid AND status <> 'void'`;
            if (existing.length > 0) throw new ConflictError(`This sale already has an invoice: ${existing[0].reference} (id ${existing[0].id}). Void it first to make another`);

            const lines = await tx.$queryRaw<{ line_no: number; sku_id: string; sku_code: string; style_name: string; size: string; color: string; quantity: number; unit_price: string; standard_total: string; line_total: string }[]>`
                SELECT l.line_no, l.sku_id, k.sku_code, st.name AS style_name, k.size, k.color, l.quantity, l.unit_price_standard::text AS unit_price, l.line_standard_total::text AS standard_total, l.line_total::text AS line_total
                FROM sale_lines l JOIN skus k ON k.id = l.sku_id JOIN styles st ON st.id = k.style_id WHERE l.sale_id = ${saleId}::uuid ORDER BY l.line_no`;
            const created = await tx.invoice.create({
                data: {
                    kind: 'b2c', status: 'draft', saleId, issuerBranchId: sale.branch_id, issuerName: sale.branch_name, recipientName: extra.customerName, recipientPhone: extra.customerPhone,
                    currency: sale.currency.trim(), subtotal: sale.subtotal, discountTotal: sale.discount, total: sale.total, note: extra.note, issuedBy: actorId,
                    exchangeRate: sale.exchange_rate, totalLbp: sale.total_lbp === null ? null : BigInt(sale.total_lbp),
                    lines: { create: lines.map((l) => ({ lineNo: l.line_no, skuId: l.sku_id, skuCode: l.sku_code, description: `${l.style_name}, ${l.size}, ${l.color}`, quantity: l.quantity, unitPrice: l.unit_price, discountAmount: formatCents(cents(l.standard_total) - cents(l.line_total)), lineTotal: l.line_total, priceSource: 'sale' })) },
                },
            });
            // the invoice of a sale is final at once: numbered and locked
            await tx.$executeRaw`UPDATE invoices SET status = 'final', reference = 'B2C-' || lpad(nextval('invoice_b2c_ref_seq')::text, 8, '0'), finalized_at = now(), finalized_by = ${actorId}::uuid WHERE id = ${created.id}::uuid`;
            await writeAudit(tx, { actorId, action: 'invoice.create', entityType: 'invoice', entityId: created.id, branchId: sale.branch_id, details: { kind: 'b2c', sale: sale.reference, customer: extra.customerName, total: sale.total } });
            return created.id;
        });
    }

    async updateDraft(invoiceId: string, actorId: string, request: UpdateInvoiceRequest, authorize: Authorize): Promise<string> {
        return this.run(async (tx) => {
            const invoice = await this.lock(tx, invoiceId, authorize);
            if (invoice.kind === 'b2c') throw new ConflictError('The invoice of a sale cannot be edited: void it and make it again');
            if (invoice.status !== 'draft') throw new ConflictError(`Only a draft can be edited: this invoice is ${invoice.status}. Void it and make a new one`);

            const lines = await tx.$queryRaw<{ id: string; sku_id: string; sku_code: string; quantity: number; unit_price: string }[]>`SELECT id, sku_id, sku_code, quantity, unit_price::text AS unit_price FROM invoice_lines WHERE invoice_id = ${invoiceId}::uuid`;
            const bySku = new Map(lines.map((l) => [l.sku_id, l]));
            const changes: { sku: string; before: string; after: string }[] = [];
            for (const edit of request.prices) {
                const line = bySku.get(edit.skuId);
                if (!line) throw new ValidationError('A product in lines is not on this invoice');
                const after = formatCents(edit.unitPriceCents);
                if (after !== line.unit_price) changes.push({ sku: line.sku_code, before: line.unit_price, after });
                await tx.$executeRaw`UPDATE invoice_lines SET unit_price = ${after}::numeric, line_total = (${line.quantity} * ${after}::numeric)::numeric(14,2), price_source = 'manual' WHERE id = ${line.id}::uuid`;
            }
            const totals = await tx.$queryRaw<{ total: string }[]>`SELECT COALESCE(SUM(line_total), 0)::text AS total FROM invoice_lines WHERE invoice_id = ${invoiceId}::uuid`;
            const noteChanged = request.note !== undefined;
            if (noteChanged) await tx.$executeRaw`UPDATE invoices SET note = ${request.note ?? null}::text WHERE id = ${invoiceId}::uuid`;
            await tx.$executeRaw`UPDATE invoices SET subtotal = ${totals[0].total}::numeric, total = ${totals[0].total}::numeric WHERE id = ${invoiceId}::uuid`;
            if (changes.length > 0 || noteChanged) await writeAudit(tx, { actorId, action: 'invoice.update', entityType: 'invoice', entityId: invoiceId, branchId: invoice.issuer_branch_id, details: { prices: changes, total: totals[0].total } });
            return invoiceId;
        });
    }

    async finalize(invoiceId: string, actorId: string, authorize: Authorize): Promise<string> {
        return this.run(async (tx) => {
            const invoice = await this.lock(tx, invoiceId, authorize);
            if (invoice.status !== 'draft') throw new ConflictError(`This invoice is already ${invoice.status}`);
            const unpriced = await tx.$queryRaw<{ sku_code: string }[]>`SELECT sku_code FROM invoice_lines WHERE invoice_id = ${invoiceId}::uuid AND price_source = 'missing' ORDER BY line_no`;
            if (unpriced.length > 0) throw new ConflictError(`No cost is known for ${unpriced.map((l) => l.sku_code).join(', ')}: set the price of ${unpriced.length === 1 ? 'this line' : 'these lines'} before finalizing`);
            const rows = await tx.$queryRaw<{ reference: string }[]>`
                UPDATE invoices SET status = 'final', finalized_at = now(), finalized_by = ${actorId}::uuid,
                    reference = CASE kind WHEN 'b2b_return' THEN 'B2BR-' || lpad(nextval('invoice_b2b_return_ref_seq')::text, 8, '0') ELSE 'B2B-' || lpad(nextval('invoice_b2b_ref_seq')::text, 8, '0') END
                WHERE id = ${invoiceId}::uuid RETURNING reference`;
            await writeAudit(tx, { actorId, action: 'invoice.finalize', entityType: 'invoice', entityId: invoiceId, branchId: invoice.issuer_branch_id, details: { reference: rows[0].reference } });
            return invoiceId;
        });
    }

    async void(invoiceId: string, actorId: string, reason: string, authorize: Authorize): Promise<string> {
        return this.run(async (tx) => {
            const invoice = await this.lock(tx, invoiceId, authorize);
            if (invoice.status === 'draft') throw new ConflictError('A draft is not void: delete it instead');
            if (invoice.status === 'void') throw new ConflictError('This invoice is already void');
            await tx.$executeRaw`UPDATE invoices SET status = 'void', voided_at = now(), voided_by = ${actorId}::uuid, void_reason = ${reason} WHERE id = ${invoiceId}::uuid`;
            await writeAudit(tx, { actorId, action: 'invoice.void', entityType: 'invoice', entityId: invoiceId, branchId: invoice.issuer_branch_id, details: { reference: invoice.reference, reason } });
            return invoiceId;
        });
    }

    async deleteDraft(invoiceId: string, actorId: string, authorize: Authorize): Promise<void> {
        await this.run(async (tx) => {
            const invoice = await this.lock(tx, invoiceId, authorize);
            if (invoice.status !== 'draft') throw new ConflictError(`Only a draft can be deleted: this invoice is ${invoice.status}. Void it instead`);
            await tx.$executeRaw`DELETE FROM invoice_lines WHERE invoice_id = ${invoiceId}::uuid`;
            await tx.$executeRaw`DELETE FROM invoices WHERE id = ${invoiceId}::uuid`;
            await writeAudit(tx, { actorId, action: 'invoice.delete', entityType: 'invoice', entityId: invoiceId, branchId: invoice.issuer_branch_id, details: { kind: invoice.kind } });
        });
    }
}
