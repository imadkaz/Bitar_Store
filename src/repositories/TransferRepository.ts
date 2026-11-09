import { Prisma, PrismaClient } from '../generated/prisma/client';
import { TransferStatus } from '../models/Transfer.model';
import { ITransferRepository, TransferListFilter, TransferView } from './interfaces/ITransferRepository';

export class TransferRepository implements ITransferRepository {
    constructor(private readonly prisma: PrismaClient) {}

    private async hydrate(rows: Prisma.TransferGetPayload<{ include: { lines: true } }>[]): Promise<TransferView[]> {
        const skuIds = [...new Set(rows.flatMap((t) => t.lines.map((l) => l.skuId)))];
        const placeIds = [...new Set(rows.flatMap((t) => [t.sourceBranchId, t.destinationBranchId]))];
        const userIds = [...new Set(rows.flatMap((t) => [t.requestedBy, ...(t.dispatchedBy ? [t.dispatchedBy] : [])]))];
        const skus = new Map((await this.prisma.sku.findMany({ where: { id: { in: skuIds } }, include: { style: true } })).map((s) => [s.id, s]));
        const places = new Map((await this.prisma.branch.findMany({ where: { id: { in: placeIds } } })).map((b) => [b.id, { id: b.id, code: b.code, name: b.name, kind: b.kind }]));
        const users = new Map((await this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, fullName: true } })).map((u) => [u.id, u.fullName]));
        const receiptRows = await this.prisma.$queryRaw<{ id: string; transfer_id: string; received_by: string; received_at: Date; note: string | null; receiver: string | null }[]>`
            SELECT r.id, r.transfer_id, r.received_by, r.received_at, r.note, u.full_name AS receiver FROM transfer_receipts r LEFT JOIN users u ON u.id = r.received_by
            WHERE r.transfer_id = ANY(${rows.map((t) => t.id)}::uuid[]) ORDER BY r.received_at, r.id`;
        const receiptLines = receiptRows.length === 0 ? [] : await this.prisma.$queryRaw<{ receipt_id: string; sku_id: string; accepted_qty: number; damaged_qty: number }[]>`
            SELECT receipt_id, sku_id, accepted_qty, damaged_qty FROM transfer_receipt_lines WHERE receipt_id = ANY(${receiptRows.map((r) => r.id)}::uuid[])`;
        const damagedBy = new Map<string, number>();
        for (const r of receiptRows) for (const l of receiptLines.filter((x) => x.receipt_id === r.id)) damagedBy.set(`${r.transfer_id}:${l.sku_id}`, (damagedBy.get(`${r.transfer_id}:${l.sku_id}`) ?? 0) + l.damaged_qty);
        const who = (id: string) => ({ id, name: users.get(id) ?? null });
        const invoices = new Map((await this.prisma.invoice.findMany({ where: { transferId: { in: rows.map((t) => t.id) }, status: { not: 'void' } }, select: { id: true, transferId: true, kind: true, reference: true, status: true, total: true } })).map((i) => [`${i.transferId}:${i.kind}`, { id: i.id, reference: i.reference, status: i.status, total: i.total.toFixed(2) }]));

        return rows.map((t) => ({
            id: t.id,
            reference: t.reference,
            status: t.status as TransferStatus,
            source: places.get(t.sourceBranchId)!,
            destination: places.get(t.destinationBranchId)!,
            note: t.note,
            requestedBy: who(t.requestedBy),
            requestedAt: t.requestedAt,
            dispatchedBy: t.dispatchedBy ? who(t.dispatchedBy) : null,
            dispatchedAt: t.dispatchedAt,
            lines: [...t.lines]
                .map((l) => ({ line: l, sku: skus.get(l.skuId)! }))
                .sort((a, b) => a.sku.skuCode.localeCompare(b.sku.skuCode))
                .map(({ line, sku }) => ({
                    skuId: line.skuId, skuCode: sku.skuCode, styleName: sku.style.name, size: sku.size, color: sku.color,
                    requestedQty: line.requestedQty, dispatchedQty: line.dispatchedQty, receivedQty: line.receivedQty, resolvedQty: line.resolvedQty,
                    outstandingQty: line.dispatchedQty - line.receivedQty - line.resolvedQty,
                    damagedQty: damagedBy.get(`${t.id}:${line.skuId}`) ?? 0,
                })),
            receipts: receiptRows.filter((x) => x.transfer_id === t.id).map((x) => ({
                id: x.id, at: x.received_at, by: { id: x.received_by, name: x.receiver }, note: x.note,
                lines: receiptLines.filter((l) => l.receipt_id === x.id).map((l) => ({ skuId: l.sku_id, accepted: l.accepted_qty, damaged: l.damaged_qty })),
            })),
            expectedAt: t.expectedAt ?? null,
            supplyInvoice: invoices.get(`${t.id}:b2b`) ?? null,
            returnInvoice: invoices.get(`${t.id}:b2b_return`) ?? null,
        }));
    }

    async findById(id: string): Promise<TransferView | null> {
        const row = await this.prisma.transfer.findUnique({ where: { id }, include: { lines: true } });
        return row ? (await this.hydrate([row]))[0] : null;
    }

    async list(filter: TransferListFilter): Promise<{ items: TransferView[]; total: number }> {
        const touching = (ids: string[]): Prisma.TransferWhereInput => ({ OR: [{ sourceBranchId: { in: ids } }, { destinationBranchId: { in: ids } }] });
        const where: Prisma.TransferWhereInput = {
            AND: [
                ...(filter.placeIds ? [touching(filter.placeIds)] : []),
                ...(filter.branchId ? [touching([filter.branchId])] : []),
                ...(filter.status ? [{ status: filter.status }] : []),
            ],
        };
        const [rows, total] = await Promise.all([
            this.prisma.transfer.findMany({ where, include: { lines: true }, orderBy: [{ requestedAt: 'desc' }, { reference: 'desc' }], take: filter.limit, skip: filter.offset }),
            this.prisma.transfer.count({ where }),
        ]);
        return { items: await this.hydrate(rows), total };
    }
}
