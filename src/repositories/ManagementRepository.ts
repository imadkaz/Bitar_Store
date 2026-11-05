import { Prisma, PrismaClient } from '../generated/prisma/client';
import { ConflictError } from '../utils/exeptions/ConflictError';
import { NotFoundError } from '../utils/exeptions/NotFoundError';
import { writeAudit } from './audit';

const TX = { maxWait: 10_000, timeout: 30_000 };
const isCode = (error: unknown, code: string) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;

export interface PermissionTarget { id: string; fullName: string; role: string; isActive: boolean; allBranches: boolean; branchIds: string[]; overrides: { permission: string; effect: string }[] }

export interface CategoryView { id: string; name: string; isActive: boolean; productCount: number; createdAt: Date }

// Everything that adds or REMOVES things the owner manages: categories, products, branches, users.
// A removal is allowed only when nothing in the history points at the thing. The database foreign keys have the last word:
// if anything points at it, the delete fails and the whole transaction is undone.
export class ManagementRepository {
    constructor(private readonly prisma: PrismaClient) {}

    // ---- categories
    async listCategories(activeOnly: boolean): Promise<CategoryView[]> {
        const rows = await this.prisma.$queryRaw<{ id: string; name: string; is_active: boolean; created_at: Date; product_count: number }[]>(Prisma.sql`
            SELECT c.id, c.name, c.is_active, c.created_at, COUNT(s.id)::int AS product_count
            FROM categories c LEFT JOIN styles s ON s.category = c.name
            ${activeOnly ? Prisma.sql`WHERE c.is_active` : Prisma.empty}
            GROUP BY c.id ORDER BY lower(c.name)`);
        return rows.map((r) => ({ id: r.id, name: r.name, isActive: r.is_active, productCount: r.product_count, createdAt: r.created_at }));
    }

    private async categoryView(id: string): Promise<CategoryView> {
        const found = (await this.listCategories(false)).find((c) => c.id === id);
        if (!found) throw new NotFoundError('Category not found');
        return found;
    }

    async createCategory(name: string, actorId: string): Promise<CategoryView> {
        try {
            const id = await this.prisma.$transaction(async (tx) => {
                const row = await tx.category.create({ data: { name, createdBy: actorId, updatedBy: actorId } });
                await writeAudit(tx, { actorId, action: 'category.create', entityType: 'category', entityId: row.id, details: { name } });
                return row.id;
            }, TX);
            return this.categoryView(id);
        } catch (error) {
            if (isCode(error, 'P2002')) throw new ConflictError('A category with this name already exists');
            throw error;
        }
    }

    // renaming also renames it on every product that uses it (the database does it)
    async updateCategory(id: string, change: { name?: string; isActive?: boolean }, actorId: string): Promise<CategoryView> {
        try {
            await this.prisma.$transaction(async (tx) => {
                const before = await tx.category.findUnique({ where: { id } });
                if (!before) throw new NotFoundError('Category not found');
                await tx.category.update({ where: { id }, data: { ...change, updatedBy: actorId } });
                await writeAudit(tx, { actorId, action: 'category.update', entityType: 'category', entityId: id, details: { before: { name: before.name, isActive: before.isActive }, after: { name: change.name ?? before.name, isActive: change.isActive ?? before.isActive } } });
            }, TX);
            return this.categoryView(id);
        } catch (error) {
            if (isCode(error, 'P2002')) throw new ConflictError('A category with this name already exists');
            throw error;
        }
    }

    async deleteCategory(id: string, actorId: string): Promise<void> {
        const view = await this.categoryView(id);
        if (view.productCount > 0) throw new ConflictError(`${view.productCount} product(s) use this category: move them to another category first, or deactivate it`);
        try {
            await this.prisma.$transaction(async (tx) => {
                await tx.category.delete({ where: { id } });
                await writeAudit(tx, { actorId, action: 'category.delete', entityType: 'category', entityId: id, details: { name: view.name } });
            }, TX);
        } catch (error) {
            if (isCode(error, 'P2003')) throw new ConflictError('A product was just given this category: move it first, or deactivate the category');
            throw error;
        }
    }

    // ---- products
    private async removeSkuRows(tx: Prisma.TransactionClient, skuIds: string[]) {
        // these belong to the product itself, they are not history
        await tx.barcode.deleteMany({ where: { skuId: { in: skuIds } } });
        await tx.skuPriceHistory.deleteMany({ where: { skuId: { in: skuIds } } });
        await tx.reorderLevel.deleteMany({ where: { skuId: { in: skuIds } } });
        await tx.sku.deleteMany({ where: { id: { in: skuIds } } });
    }

    async deleteSku(id: string, actorId: string): Promise<void> {
        try {
            await this.prisma.$transaction(async (tx) => {
                const sku = await tx.sku.findUnique({ where: { id } });
                if (!sku) throw new NotFoundError('Sku not found');
                await this.removeSkuRows(tx, [id]);
                await writeAudit(tx, { actorId, action: 'sku.delete', entityType: 'sku', entityId: id, details: { skuCode: sku.skuCode } });
            }, TX);
        } catch (error) {
            if (isCode(error, 'P2003')) throw new ConflictError('This product has history (sales, stock or transfers): archive it instead (isActive: false)');
            throw error;
        }
    }

    async deleteStyle(id: string, actorId: string): Promise<void> {
        try {
            await this.prisma.$transaction(async (tx) => {
                const style = await tx.style.findUnique({ where: { id }, include: { skus: { select: { id: true } } } });
                if (!style) throw new NotFoundError('Style not found');
                if (style.skus.length > 0) await this.removeSkuRows(tx, style.skus.map((s) => s.id));
                await tx.style.delete({ where: { id } });
                await writeAudit(tx, { actorId, action: 'style.delete', entityType: 'style', entityId: id, details: { code: style.code, skus: style.skus.length } });
            }, TX);
        } catch (error) {
            if (isCode(error, 'P2003')) throw new ConflictError('This product has history (sales, stock or transfers): archive it instead (isActive: false)');
            throw error;
        }
    }

    /** Permanently removes records attached to a branch as part of an explicit admin deletion. */
    private async purgeBranchData(tx: Prisma.TransactionClient, branchId: string): Promise<void> {
        const transfers = await tx.transfer.findMany({
            where: { OR: [{ sourceBranchId: branchId }, { destinationBranchId: branchId }] },
            select: { id: true },
        });
        if (transfers.length > 0) {
            throw new ConflictError('This branch has transfer history involving another branch; deactivate it instead (isActive: false)');
        }

        await tx.$executeRaw`SET LOCAL app.allow_branch_history_purge = 'on'`;

        const sales = await tx.sale.findMany({ where: { branchId }, select: { id: true, idempotencyKeyId: true } });
        const saleIds = sales.map((row) => row.id);
        const adjustments = await tx.adjustment.findMany({ where: { branchId }, select: { id: true, idempotencyKeyId: true } });
        const adjustmentIds = adjustments.map((row) => row.id);
        const receipts = await tx.goodsReceipt.findMany({ where: { branchId }, select: { id: true, idempotencyKeyId: true } });
        const receiptIds = receipts.map((row) => row.id);

        const invoiceWhere: Prisma.InvoiceWhereInput[] = [{ issuerBranchId: branchId }, { recipientBranchId: branchId }];
        if (saleIds.length > 0) invoiceWhere.push({ saleId: { in: saleIds } });
        const invoices = await tx.invoice.findMany({ where: { OR: invoiceWhere }, select: { id: true } });
        const invoiceIds = invoices.map((row) => row.id);

        const movementWhere: Prisma.StockMovementWhereInput[] = [{ branchId }];
        if (saleIds.length > 0) movementWhere.push({ saleId: { in: saleIds } });
        if (adjustmentIds.length > 0) movementWhere.push({ adjustmentId: { in: adjustmentIds } });
        if (receiptIds.length > 0) movementWhere.push({ goodsReceiptId: { in: receiptIds } });
        const movements = await tx.stockMovement.findMany({ where: { OR: movementWhere }, select: { idempotencyKeyId: true } });
        await tx.stockMovement.deleteMany({ where: { OR: movementWhere } });

        if (invoiceIds.length > 0) {
            await tx.invoiceLine.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
            await tx.invoice.deleteMany({ where: { id: { in: invoiceIds } } });
        }
        if (saleIds.length > 0) {
            await tx.salePayment.deleteMany({ where: { saleId: { in: saleIds } } });
            await tx.$executeRaw(Prisma.sql`
                DELETE FROM sale_line_costs
                WHERE sale_line_id IN (SELECT id FROM sale_lines WHERE sale_id IN (${Prisma.join(saleIds)}))
            `);
            await tx.saleLine.deleteMany({ where: { saleId: { in: saleIds } } });
            await tx.sale.deleteMany({ where: { id: { in: saleIds } } });
        }
        if (adjustmentIds.length > 0) await tx.adjustment.deleteMany({ where: { id: { in: adjustmentIds } } });
        if (receiptIds.length > 0) {
            await tx.goodsReceiptLine.deleteMany({ where: { receiptId: { in: receiptIds } } });
            await tx.goodsReceipt.deleteMany({ where: { id: { in: receiptIds } } });
        }

        await tx.stockAlert.deleteMany({ where: { branchId } });
        await tx.stockBalance.deleteMany({ where: { branchId } });
        await tx.$executeRaw`DELETE FROM stock_costs WHERE branch_id = ${branchId}::uuid`;
        await tx.reorderLevel.deleteMany({ where: { branchId } });
        await tx.userBranchAccess.deleteMany({ where: { branchId } });
        const auditWhere: Prisma.AuditEventWhereInput[] = [
            { branchId },
            { entityType: 'branch', entityId: branchId },
        ];
        if (saleIds.length > 0) auditWhere.push({ entityType: 'sale', entityId: { in: saleIds } });
        if (adjustmentIds.length > 0) auditWhere.push({ entityType: 'adjustment', entityId: { in: adjustmentIds } });
        if (receiptIds.length > 0) auditWhere.push({ entityType: 'goods_receipt', entityId: { in: receiptIds } });
        if (invoiceIds.length > 0) auditWhere.push({ entityType: 'invoice', entityId: { in: invoiceIds } });
        await tx.auditEvent.deleteMany({ where: { OR: auditWhere } });

        const idempotencyIds = [
            ...sales.map((row) => row.idempotencyKeyId),
            ...adjustments.map((row) => row.idempotencyKeyId),
            ...receipts.map((row) => row.idempotencyKeyId),
            ...movements.map((row) => row.idempotencyKeyId),
        ];
        const uniqueIdempotencyIds = [...new Set(idempotencyIds)];
        if (uniqueIdempotencyIds.length > 0) await tx.idempotencyKey.deleteMany({ where: { id: { in: uniqueIdempotencyIds } } });

        await tx.$executeRaw`SET LOCAL app.allow_branch_history_purge = 'off'`;
    }

    // ---- branches
    async deleteBranch(id: string, actorId: string): Promise<void> {
        try {
            await this.prisma.$transaction(async (tx) => {
                const branch = await tx.branch.findUnique({ where: { id } });
                if (!branch) throw new NotFoundError('Branch not found');
                await this.purgeBranchData(tx, id);
                await tx.branch.delete({ where: { id } });
                await writeAudit(tx, { actorId, action: 'branch.delete', entityType: 'branch', entityId: id, details: { code: branch.code, kind: branch.kind, purgedHistory: true } });
            }, TX);
        } catch (error) {
            if (isCode(error, 'P2003')) throw new ConflictError('This branch still has linked records and could not be deleted');
            throw error;
        }
    }

    // ---- users: the user disappears, everything they did stays
    async softDeleteUser(id: string, actorId: string): Promise<void> {
        await this.prisma.$transaction(async (tx) => {
            const user = await tx.user.findFirst({ where: { id, deletedAt: null } });
            if (!user) throw new NotFoundError('User not found');
            if (user.role === 'admin' && user.isActive) {
                const others = await tx.user.count({ where: { role: 'admin', isActive: true, deletedAt: null, id: { not: id } } });
                if (others === 0) throw new ConflictError('This is the last active admin: make another admin first');
            }
            await tx.userBranchAccess.deleteMany({ where: { userId: id } });
            await tx.userPermissionOverride.deleteMany({ where: { userId: id } });
            const now = new Date();
            await tx.user.update({
                where: { id },
                data: { deletedAt: now, isActive: false, deactivatedAt: user.deactivatedAt ?? now, passwordHash: null, email: `deleted-${id}@deleted.invalid`, updatedBy: actorId },
            });
            await writeAudit(tx, { actorId, action: 'user.delete', entityType: 'user', entityId: id, details: { email: user.email, fullName: user.fullName, role: user.role } });
        }, TX);
    }

    // ---- permissions of one user: the overrides on top of their role
    async findPermissionTarget(userId: string): Promise<PermissionTarget | null> {
        const user = await this.prisma.user.findFirst({ where: { id: userId, deletedAt: null } });
        if (!user) return null;
        const [overrides, access] = await Promise.all([
            this.prisma.userPermissionOverride.findMany({ where: { userId } }),
            this.prisma.userBranchAccess.findMany({ where: { userId }, select: { branchId: true } }),
        ]);
        return {
            id: user.id, fullName: user.fullName, role: user.role, isActive: user.isActive, allBranches: user.allBranches, branchIds: access.map((a) => a.branchId),
            overrides: overrides.map((o) => ({ permission: o.permission, effect: o.effect })),
        };
    }

    // a manager appointed to every branch (or back to the ones listed for them)
    async setAllBranches(userId: string, allBranches: boolean, actorId: string): Promise<void> {
        await this.prisma.$transaction(async (tx) => {
            const user = await tx.user.findFirst({ where: { id: userId, deletedAt: null } });
            if (!user) throw new NotFoundError('User not found');
            if (user.allBranches === allBranches) return;
            await tx.user.update({ where: { id: userId }, data: { allBranches, updatedBy: actorId } });
            await writeAudit(tx, { actorId, action: 'user.branch_access', entityType: 'user', entityId: userId, details: { before: user.allBranches ? 'all' : 'selected', after: allBranches ? 'all' : 'selected', user: user.fullName } });
        }, TX);
    }

    // the overrides are replaced as a whole, with the audit event, in one transaction
    async replacePermissionOverrides(userId: string, overrides: { permission: string; effect: string }[], actorId: string, details: Record<string, unknown>): Promise<void> {
        await this.prisma.$transaction(async (tx) => {
            await tx.userPermissionOverride.deleteMany({ where: { userId } });
            if (overrides.length > 0) await tx.userPermissionOverride.createMany({ data: overrides.map((o) => ({ userId, permission: o.permission, effect: o.effect, createdBy: actorId })) });
            await writeAudit(tx, { actorId, action: 'user.permissions', entityType: 'user', entityId: userId, details });
        }, TX);
    }
}
