import { createHash } from 'node:crypto';
import { AuthContext } from '../../models/AuthContext';
import { GoodsReceiptRequest, parseGoodsReceipt, totalCostCents } from '../../models/GoodsReceipt.model';
import { formatCents } from '../../models/Money';
import { GoodsReceiptSummary, GoodsReceiptView, IGoodsReceiptRepository } from '../../repositories/interfaces/IGoodsReceiptRepository';
import { IGoodsReceiptUnitOfWork } from '../../repositories/interfaces/IGoodsReceiptUnitOfWork';
import { ILocationRepository } from '../../repositories/interfaces/ILocationRepository';
import { ConflictError } from '../../utils/exeptions/ConflictError';
import { ForbiddenError } from '../../utils/exeptions/ForbiddenError';
import { NotFoundError } from '../../utils/exeptions/NotFoundError';
import { ValidationError } from '../../utils/exeptions/ValidationError';
import { isUuid } from '../../utils/uuid';
import { resolvePaging } from '../styles/paging';
import { parseOptionalUuid, parseShopDay } from '../insight/scope';
import { parseIdempotencyKey } from '../sales/saleRequest';
import { canManageSuppliers } from '../suppliers/SupplierUsecases';

export interface GoodsReceiptResult {
    receipt: GoodsReceiptView;
    replayed: boolean;     // true when this exact request had already been done: nothing new happened
}

// The supplier's delivery comes into the WAREHOUSE as a document. The warehouse stock grows from it, in the same transaction,
// and the document stays: who supplied it, the supplier's invoice number and date, what was paid for each product, who received it.
// It can never be edited or deleted: a mistake is corrected with a stock adjustment.
abstract class WarehouseDocumentUsecase {
    constructor(protected readonly locations: ILocationRepository) {}

    protected async warehouseFor(auth: AuthContext): Promise<{ id: string }> {
        if (!auth.can('adjustments.create')) throw new ForbiddenError('Missing permission: adjustments.create');
        const warehouse = await this.locations.findWarehouse();
        if (!warehouse) throw new ConflictError('There is no warehouse yet');
        if (!auth.canAccessBranch(warehouse.getId())) throw new ForbiddenError('You do not reach the warehouse');
        return { id: warehouse.getId() };
    }
}

export class CreateGoodsReceiptUsecase extends WarehouseDocumentUsecase {
    constructor(locations: ILocationRepository, private readonly unitOfWork: IGoodsReceiptUnitOfWork, private readonly receipts: IGoodsReceiptRepository, private readonly now: () => Date = () => new Date()) {
        super(locations);
    }

    async execute(body: unknown, idempotencyKeyHeader: unknown, auth: AuthContext): Promise<GoodsReceiptResult> {
        const actorId = auth.user.getId();
        const warehouse = await this.warehouseFor(auth);
        const key = parseIdempotencyKey(idempotencyKeyHeader);
        const request: GoodsReceiptRequest = parseGoodsReceipt(body, this.now());
        const total = totalCostCents(request.lines);
        const hash = createHash('sha256').update(JSON.stringify(['goods_receipt.create', request])).digest('hex');

        let replayed = false;
        const id = await this.unitOfWork.run(async (tx) => {
            const claim = await tx.claimIdempotencyKey(actorId, 'goods_receipt.create', key, hash);
            if (claim.kind === 'replay') { replayed = true; return claim.resourceId; }
            if (claim.kind === 'different_request') throw new ConflictError('This Idempotency-Key was already used for a different request');
            if (claim.kind === 'in_progress') throw new ConflictError('This request is already being processed');

            const supplier = await tx.resolveSupplier(request, canManageSuppliers(auth), actorId);
            if (request.supplierInvoiceNumber !== null) {
                const duplicate = await tx.findDuplicate(supplier.id, request.supplierInvoiceNumber);
                if (duplicate) throw new ConflictError(`This supplier invoice was already received as ${duplicate.reference}`);
            }

            const skus = await tx.findSkus(request.lines.map((l) => l.skuId));
            const known = new Map(skus.map((s) => [s.skuId, s]));
            if (known.size !== request.lines.length) throw new NotFoundError('One or more products were not found');
            const archived = skus.filter((s) => !s.skuActive || !s.styleActive).map((s) => s.skuCode);
            if (archived.length > 0) throw new ConflictError(`Archived products cannot be received: ${archived.join(', ')}`);

            const created = await tx.insertReceipt(request, supplier, total, warehouse.id, actorId, claim.keyId);
            await tx.applyReceipt(created.id, warehouse.id, request.lines, actorId, claim.keyId);
            await tx.audit({
                actorId, action: 'goods_receipt.create', entityType: 'goods_receipt', entityId: created.id, branchId: warehouse.id,
                details: { reference: created.reference, supplier: supplier.name, supplierId: supplier.id, invoice: request.supplierInvoiceNumber, lines: request.lines.length, pieces: request.lines.reduce((n, l) => n + l.quantity, 0), total: formatCents(total), currency: request.currency },
            });
            await tx.completeIdempotencyKey(claim.keyId, 'goods_receipt', created.id);
            return created.id;
        });
        return { receipt: (await this.receipts.findById(id))!, replayed };
    }
}

export class GetGoodsReceiptUsecase extends WarehouseDocumentUsecase {
    constructor(locations: ILocationRepository, private readonly receipts: IGoodsReceiptRepository) { super(locations); }

    async execute(rawId: string, auth: AuthContext): Promise<GoodsReceiptView> {
        await this.warehouseFor(auth);
        if (!isUuid(rawId)) throw new NotFoundError('Goods receipt not found');
        const receipt = await this.receipts.findById(rawId);
        if (!receipt) throw new NotFoundError('Goods receipt not found');
        return receipt;
    }
}

export class ListGoodsReceiptsUsecase extends WarehouseDocumentUsecase {
    constructor(locations: ILocationRepository, private readonly receipts: IGoodsReceiptRepository) { super(locations); }

    async execute(input: { supplier?: unknown; supplierId?: unknown; invoiceNumber?: unknown; skuId?: unknown; from?: unknown; to?: unknown; limit?: unknown; offset?: unknown }, auth: AuthContext): Promise<{ items: GoodsReceiptSummary[]; total: number }> {
        await this.warehouseFor(auth);
        const text = (value: unknown, label: string): string | undefined => {
            if (value === undefined) return undefined;
            if (typeof value !== 'string' || value.trim().length < 1 || value.trim().length > 100) throw new ValidationError(`${label} must be 1 to 100 characters`);
            return value.trim();
        };
        const from = parseShopDay(input.from, 'from');
        const to = parseShopDay(input.to, 'to');
        if (from && to && from > to) throw new ValidationError('from must not be after to');
        const { limit, offset } = resolvePaging(input.limit, input.offset);
        return this.receipts.list({ supplier: text(input.supplier, 'supplier'), supplierId: parseOptionalUuid(input.supplierId, 'supplierId'), invoiceNumber: text(input.invoiceNumber, 'invoiceNumber'), skuId: parseOptionalUuid(input.skuId, 'skuId'), from, to, limit, offset });
    }
}
