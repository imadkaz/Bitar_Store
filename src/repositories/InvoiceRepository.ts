import { Prisma, PrismaClient } from '../generated/prisma/client';
import { BUSINESS_TIME_ZONE } from '../utils/businessDate';
import { IInvoiceRepository, InvoiceKind, InvoiceLineView, InvoiceListFilter, InvoiceStatus, InvoiceSummary, InvoiceView } from './interfaces/IInvoiceRepository';

interface Row {
    id: string; kind: InvoiceKind; status: InvoiceStatus; reference: string | null; transfer_id: string | null; transfer_ref: string | null; sale_id: string | null; sale_ref: string | null;
    issuer_branch_id: string; issuer_name: string; recipient_branch_id: string | null; recipient_name: string | null; recipient_phone: string | null; currency: string;
    subtotal: string; discount_total: string; total: string; exchange_rate: number | null; total_lbp: string | null; note: string | null; issued_by: string; issuer_user: string | null; created_at: Date; finalized_at: Date | null;
    voided_at: Date | null; voided_by: string | null; voider: string | null; void_reason: string | null; line_count: number;
}

const SELECT = Prisma.sql`
    SELECT i.id, i.kind, i.status, i.reference, i.transfer_id, t.reference AS transfer_ref, i.sale_id, s.reference AS sale_ref, i.issuer_branch_id, i.issuer_name,
           i.recipient_branch_id, i.recipient_name, i.recipient_phone, i.currency, i.subtotal::text AS subtotal, i.discount_total::text AS discount_total, i.total::text AS total, i.exchange_rate, i.total_lbp::text AS total_lbp,
           i.note, i.issued_by, u.full_name AS issuer_user, i.created_at, i.finalized_at, i.voided_at, i.voided_by, vu.full_name AS voider, i.void_reason,
           (SELECT COUNT(*)::int FROM invoice_lines l WHERE l.invoice_id = i.id) AS line_count
    FROM invoices i
    LEFT JOIN transfers t ON t.id = i.transfer_id
    LEFT JOIN sales s ON s.id = i.sale_id
    LEFT JOIN users u ON u.id = i.issued_by
    LEFT JOIN users vu ON vu.id = i.voided_by`;

const toSummary = (r: Row): InvoiceSummary => ({
    id: r.id, kind: r.kind, status: r.status, reference: r.reference, issuer: { id: r.issuer_branch_id, name: r.issuer_name },
    recipient: { branchId: r.recipient_branch_id, name: r.recipient_name, phone: r.recipient_phone },
    transfer: r.transfer_id ? { id: r.transfer_id, reference: r.transfer_ref ?? '' } : null, sale: r.sale_id ? { id: r.sale_id, reference: r.sale_ref ?? '' } : null,
    currency: r.currency, subtotal: r.subtotal, discountTotal: r.discount_total, total: r.total, exchangeRate: r.exchange_rate, totalLbp: r.total_lbp === null ? null : Number(r.total_lbp), note: r.note, issuedBy: { id: r.issued_by, name: r.issuer_user },
    createdAt: r.created_at, finalizedAt: r.finalized_at,
    voided: r.voided_at && r.voided_by ? { at: r.voided_at, by: { id: r.voided_by, name: r.voider }, reason: r.void_reason ?? '' } : null,
    lineCount: r.line_count,
});

export class InvoiceRepository implements IInvoiceRepository {
    constructor(private readonly prisma: PrismaClient) {}

    async findById(id: string): Promise<InvoiceView | null> {
        const rows = await this.prisma.$queryRaw<Row[]>(Prisma.sql`${SELECT} WHERE i.id = ${id}::uuid`);
        if (rows.length === 0) return null;
        const lines = await this.prisma.$queryRaw<{ line_no: number; sku_id: string; sku_code: string; description: string; quantity: number; unit_price: string; discount_amount: string; line_total: string; price_source: InvoiceLineView['priceSource'] }[]>(Prisma.sql`
            SELECT line_no, sku_id, sku_code, description, quantity, unit_price::text AS unit_price, discount_amount::text AS discount_amount, line_total::text AS line_total, price_source
            FROM invoice_lines WHERE invoice_id = ${id}::uuid ORDER BY line_no`);
        const payments = rows[0].sale_id
            ? (await this.prisma.$queryRaw<{ method: string; amount: string; reference: string | null; currency: 'USD' | 'LBP'; lbp_amount: string | null; change_lbp: string | null }[]>(Prisma.sql`
                SELECT method, amount::text AS amount, whish_reference AS reference, currency, lbp_amount::text AS lbp_amount, change_lbp::text AS change_lbp FROM sale_payments WHERE sale_id = ${rows[0].sale_id}::uuid ORDER BY created_at, method, currency DESC, id`)).map((p) => ({ method: p.method, amount: p.amount, reference: p.reference, currency: p.currency, lbpAmount: p.lbp_amount === null ? null : Number(p.lbp_amount), changeLbp: p.change_lbp === null ? null : Number(p.change_lbp) }))
            : [];
        const views: InvoiceLineView[] = lines.map((l) => ({ lineNo: l.line_no, sku: { id: l.sku_id, code: l.sku_code }, description: l.description, quantity: l.quantity, unitPrice: l.unit_price, discount: l.discount_amount, lineTotal: l.line_total, priceSource: l.price_source }));
        return { ...toSummary(rows[0]), lines: views, payments };
    }

    async list(filter: InvoiceListFilter): Promise<{ items: InvoiceSummary[]; total: number }> {
        if (filter.branchIds !== null && filter.branchIds.length === 0) return { items: [], total: 0 };
        const ids = filter.branchIds === null ? null : Prisma.join(filter.branchIds.map((id) => Prisma.sql`${id}::uuid`));
        const scope = ids === null ? Prisma.empty : Prisma.sql`AND (i.issuer_branch_id IN (${ids}) OR i.recipient_branch_id IN (${ids}))`;
        const kind = filter.kind ? Prisma.sql`AND i.kind = ${filter.kind}` : Prisma.empty;
        const status = filter.status ? Prisma.sql`AND i.status = ${filter.status}` : Prisma.empty;
        const branch = filter.branchId ? Prisma.sql`AND (i.issuer_branch_id = ${filter.branchId}::uuid OR i.recipient_branch_id = ${filter.branchId}::uuid)` : Prisma.empty;
        const transfer = filter.transferId ? Prisma.sql`AND i.transfer_id = ${filter.transferId}::uuid` : Prisma.empty;
        const saleOf = filter.saleId ? Prisma.sql`AND i.sale_id = ${filter.saleId}::uuid` : Prisma.empty;
        const like = filter.search ? `%${filter.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
        const search = like ? Prisma.sql`AND (i.reference ILIKE ${like} OR i.recipient_name ILIKE ${like} OR i.issuer_name ILIKE ${like} OR t.reference ILIKE ${like} OR s.reference ILIKE ${like})` : Prisma.empty;
        const from = filter.from ? Prisma.sql`AND i.created_at >= (${filter.from}::date)::timestamp AT TIME ZONE ${BUSINESS_TIME_ZONE}` : Prisma.empty;
        const to = filter.to ? Prisma.sql`AND i.created_at < ((${filter.to}::date + 1))::timestamp AT TIME ZONE ${BUSINESS_TIME_ZONE}` : Prisma.empty;
        const where = Prisma.sql`TRUE ${scope} ${kind} ${status} ${branch} ${transfer} ${saleOf} ${search} ${from} ${to}`;
        const [rows, count] = await Promise.all([
            this.prisma.$queryRaw<Row[]>(Prisma.sql`${SELECT} WHERE ${where} ORDER BY i.created_at DESC, i.id DESC LIMIT ${filter.limit} OFFSET ${filter.offset}`),
            this.prisma.$queryRaw<{ n: number }[]>(Prisma.sql`SELECT COUNT(*)::int AS n FROM invoices i LEFT JOIN transfers t ON t.id = i.transfer_id LEFT JOIN sales s ON s.id = i.sale_id WHERE ${where}`),
        ]);
        return { items: rows.map(toSummary), total: count[0].n };
    }
}
