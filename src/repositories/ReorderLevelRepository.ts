import { Prisma, PrismaClient } from '../generated/prisma/client';
import { ConflictError } from '../utils/exeptions/ConflictError';
import { likePattern, writeAudit } from './audit';
import { IReorderLevelRepository, ReorderLevelListFilter, ReorderLevelView } from './interfaces/IReorderLevelRepository';

interface Row {
    id: string;
    branch_id: string;
    sku_id: string;
    min_quantity: number;
    target_quantity: number | null;
    updated_at: Date;
    sku_code: string;
    size: string;
    color: string;
    style_name: string;
}

const SELECT = Prisma.sql`
    SELECT rl.id, rl.branch_id, rl.sku_id, rl.min_quantity, rl.target_quantity, rl.updated_at, k.sku_code, k.size, k.color, st.name AS style_name
    FROM reorder_levels rl
    JOIN skus k ON k.id = rl.sku_id
    JOIN styles st ON st.id = k.style_id`;

const toView = (r: Row): ReorderLevelView => ({
    id: r.id, branchId: r.branch_id, skuId: r.sku_id, skuCode: r.sku_code, styleName: r.style_name, size: r.size, color: r.color,
    minQuantity: r.min_quantity, targetQuantity: r.target_quantity, updatedAt: r.updated_at,
});

const TX = { maxWait: 10_000, timeout: 30_000 };

export class ReorderLevelRepository implements IReorderLevelRepository {
    constructor(private readonly prisma: PrismaClient) {}

    async list(filter: ReorderLevelListFilter): Promise<ReorderLevelView[]> {
        const search = filter.search ? Prisma.sql`AND (k.sku_code ILIKE ${likePattern(filter.search)} OR k.color ILIKE ${likePattern(filter.search)} OR st.name ILIKE ${likePattern(filter.search)})` : Prisma.empty;
        const rows = await this.prisma.$queryRaw<Row[]>(Prisma.sql`
            ${SELECT}
            WHERE rl.branch_id = ${filter.branchId}::uuid ${search}
            ORDER BY k.sku_code
            LIMIT ${filter.limit} OFFSET ${filter.offset}`);
        return rows.map(toView);
    }

    async findById(id: string): Promise<ReorderLevelView | null> {
        const rows = await this.prisma.$queryRaw<Row[]>(Prisma.sql`${SELECT} WHERE rl.id = ${id}::uuid`);
        return rows.length === 0 ? null : toView(rows[0]);
    }

    async findForSkus(skuIds: string[]): Promise<Map<string, { min: number; target: number | null }>> {
        const rows = await this.prisma.reorderLevel.findMany({ where: { skuId: { in: skuIds } } });
        return new Map(rows.map((r) => [`${r.skuId}|${r.branchId}`, { min: r.minQuantity, target: r.targetQuantity }]));
    }

    async upsert(branchId: string, skuId: string, min: number, target: number | null, actorId: string): Promise<ReorderLevelView> {
        try {
            const id = await this.prisma.$transaction(async (tx) => {
                const sku = await tx.sku.findUnique({ where: { id: skuId }, select: { skuCode: true } });
                const before = await tx.reorderLevel.findUnique({ where: { skuId_branchId: { skuId, branchId } } });
                const saved = before
                    ? await tx.reorderLevel.update({ where: { id: before.id }, data: { minQuantity: min, targetQuantity: target, updatedBy: actorId } })
                    : await tx.reorderLevel.create({ data: { skuId, branchId, minQuantity: min, targetQuantity: target, createdBy: actorId, updatedBy: actorId } });
                await writeAudit(tx, {
                    actorId, action: 'reorder_level.set', entityType: 'reorder_level', entityId: saved.id, branchId,
                    details: { sku: sku?.skuCode, before: before ? { min: before.minQuantity, target: before.targetQuantity } : null, after: { min, target } },
                });
                return saved.id;
            }, TX);
            return (await this.findById(id))!;
        } catch (error) {
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictError('Someone set this minimum at the same moment: please try again');
            throw error;
        }
    }

    async upsertForStyle(branchId: string, styleId: string, min: number, target: number | null, actorId: string): Promise<number> {
        try {
            return await this.prisma.$transaction(async (tx) => {
                const skus = await tx.sku.findMany({ where: { styleId, isActive: true }, select: { id: true, skuCode: true }, orderBy: { skuCode: 'asc' } });
                for (const sku of skus) {
                    await tx.reorderLevel.upsert({
                        where: { skuId_branchId: { skuId: sku.id, branchId } },
                        create: { skuId: sku.id, branchId, minQuantity: min, targetQuantity: target, createdBy: actorId, updatedBy: actorId },
                        update: { minQuantity: min, targetQuantity: target, updatedBy: actorId },
                    });
                }
                if (skus.length > 0) {
                    await writeAudit(tx, {
                        actorId, action: 'reorder_level.set_style', entityType: 'style', entityId: styleId, branchId,
                        details: { min, target, skus: skus.length, skuCodes: skus.slice(0, 50).map((s) => s.skuCode) },
                    });
                }
                return skus.length;
            }, TX);
        } catch (error) {
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictError('Someone set these minimums at the same moment: please try again');
            throw error;
        }
    }

    async delete(id: string, actorId: string): Promise<void> {
        await this.prisma.$transaction(async (tx) => {
            const before = await tx.reorderLevel.findUnique({ where: { id } });
            if (!before) return;
            await tx.reorderLevel.delete({ where: { id } });
            await writeAudit(tx, {
                actorId, action: 'reorder_level.delete', entityType: 'reorder_level', entityId: id, branchId: before.branchId,
                details: { skuId: before.skuId, before: { min: before.minQuantity, target: before.targetQuantity } },
            });
        }, TX);
    }
}
