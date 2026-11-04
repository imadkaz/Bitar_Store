import { Prisma, PrismaClient } from '../generated/prisma/client';
import { GoodsReceiptLineView, GoodsReceiptListFilter, GoodsReceiptSummary, GoodsReceiptView, IGoodsReceiptRepository } from './interfaces/IGoodsReceiptRepository';

interface Row {
    id: string; reference: string; branch_id: string; branch_code: string; branch_name: string; supplier_name: string; supplier_invoice_number: string; invoice_date: string;
    currency: string; note: string | null; total_cost: string; received_by: string; receiver: string | null; created_at: Date; line_count: number; total_quantity: number;
}

const SELECT = Prisma.sql`
    SELECT r.id, r.reference, r.branch_id, br.code AS branch_code, br.name AS branch_name, r.supplier_name, r.supplier_invoice_number, r.invoice_date::text AS invoice_date,
           r.currency, r.note, r.total_cost::text AS total_cost, r.received_by, u.full_name AS receiver, r.created_at,
           (SELECT COUNT(*)::int FROM goods_receipt_lines l WHERE l.receipt_id = r.id) AS line_count,
           (SELECT COALESCE(SUM(l.quantity), 0)::int FROM goods_receipt_lines l WHERE l.receipt_id = r.id) AS total_quantity
    FROM goods_receipts r
    JOIN branches br ON br.id = r.branch_id
    LEFT JOIN users u ON u.id = r.received_by`;

const toSummary = (r: Row): GoodsReceiptSummary => ({
    id: r.id, reference: r.reference, warehouse: { id: r.branch_id, code: r.branch_code, name: r.branch_name }, supplierName: r.supplier_name, supplierInvoiceNumber: r.supplier_invoice_number,
    invoiceDate: r.invoice_date, currency: r.currency, note: r.note, totalCost: r.total_cost, receivedBy: { id: r.received_by, name: r.receiver }, createdAt: r.created_at,
    lineCount: r.line_count, totalQuantity: r.total_quantity,
});

export class GoodsReceiptRepository implements IGoodsReceiptRepository {
    constructor(private readonly prisma: PrismaClient) {}

    async findById(id: string): Promise<GoodsReceiptView | null> {
        const rows = await this.prisma.$queryRaw<Row[]>(Prisma.sql`${SELECT} WHERE r.id = ${id}::uuid`);
        if (rows.length === 0) return null;
        const lines = await this.prisma.$queryRaw<{ sku_id: string; sku_code: string; style_name: string; size: string; color: string; quantity: number; unit_cost: string; line_total: string }[]>(Prisma.sql`
            SELECT l.sku_id, k.sku_code, st.name AS style_name, k.size, k.color, l.quantity, l.unit_cost::text AS unit_cost, (l.quantity * l.unit_cost)::numeric(14,2)::text AS line_total
            FROM goods_receipt_lines l JOIN skus k ON k.id = l.sku_id JOIN styles st ON st.id = k.style_id
            WHERE l.receipt_id = ${id}::uuid ORDER BY k.sku_code`);
        const views: GoodsReceiptLineView[] = lines.map((l) => ({
            sku: { id: l.sku_id, code: l.sku_code, styleName: l.style_name, size: l.size, color: l.color }, quantity: l.quantity, unitCost: l.unit_cost, lineTotal: l.line_total,
        }));
        return { ...toSummary(rows[0]), lines: views };
    }

    async list(filter: GoodsReceiptListFilter): Promise<{ items: GoodsReceiptSummary[]; total: number }> {
        const like = (text: string) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        const supplier = filter.supplier ? Prisma.sql`AND r.supplier_name ILIKE ${like(filter.supplier)}` : Prisma.empty;
        const invoice = filter.invoiceNumber ? Prisma.sql`AND r.supplier_invoice_number ILIKE ${like(filter.invoiceNumber)}` : Prisma.empty;
        const sku = filter.skuId ? Prisma.sql`AND EXISTS (SELECT 1 FROM goods_receipt_lines l WHERE l.receipt_id = r.id AND l.sku_id = ${filter.skuId}::uuid)` : Prisma.empty;
        const from = filter.from ? Prisma.sql`AND r.invoice_date >= ${filter.from}::date` : Prisma.empty;
        const to = filter.to ? Prisma.sql`AND r.invoice_date <= ${filter.to}::date` : Prisma.empty;
        const where = Prisma.sql`TRUE ${supplier} ${invoice} ${sku} ${from} ${to}`;
        const [rows, count] = await Promise.all([
            this.prisma.$queryRaw<Row[]>(Prisma.sql`${SELECT} WHERE ${where} ORDER BY r.created_at DESC, r.id DESC LIMIT ${filter.limit} OFFSET ${filter.offset}`),
            this.prisma.$queryRaw<{ n: number }[]>(Prisma.sql`SELECT COUNT(*)::int AS n FROM goods_receipts r WHERE ${where}`),
        ]);
        return { items: rows.map(toSummary), total: count[0].n };
    }
}
