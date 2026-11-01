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
        const who = (id: string) => ({ id, name: users.get(id) ?? null });

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
                })),
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
