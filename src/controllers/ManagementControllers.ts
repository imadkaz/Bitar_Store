import { Request, Response } from 'express';
import { getAuth } from '../middlewares/Authenticate';
import { ListSalesHistoryUsecase } from '../usecases/sales/ListSalesHistoryUsecase';
import {
    CreateCategoryUsecase, GetBranchAccessUsecase, SetBranchAccessUsecase, GetPermissionCatalogUsecase, GetUserPermissionsUsecase, SetUserPermissionsUsecase, DeleteBranchUsecase, DeleteCategoryUsecase, DeleteSkuUsecase, DeleteStyleUsecase, SoftDeleteUserUsecase, GetWarehouseUsecase, ListCategoriesUsecase, UpdateCategoryUsecase,
    ListPlacesUsecase,
} from '../usecases/management/ManagementUsecases';
import { boolParam, intParam, textParam } from './query';
import { CreateAdjustmentUsecase, ListAdjustmentsUsecase } from '../usecases/adjustments/AdjustmentUsecases';
import { AdjustmentView } from '../repositories/interfaces/IAdjustmentRepository';
import { CreateGoodsReceiptUsecase, GetGoodsReceiptUsecase, ListGoodsReceiptsUsecase } from '../usecases/goodsreceipts/GoodsReceiptUsecases';
import { CreateInvoiceUsecase, GetInvoiceUsecase, ListInvoicesUsecase, UpdateInvoiceUsecase, FinalizeInvoiceUsecase, VoidInvoiceUsecase, DeleteInvoiceUsecase, GetInvoicePdfUsecase } from '../usecases/invoices/InvoiceUsecases';

export class CategoryController {
    constructor(
        private readonly list: ListCategoriesUsecase,
        private readonly create: CreateCategoryUsecase,
        private readonly update: UpdateCategoryUsecase,
        private readonly remove: DeleteCategoryUsecase,
    ) {}

    listCategories = async (req: Request, res: Response) => { res.status(200).json(await this.list.execute({ activeOnly: boolParam(req, 'activeOnly') })); };
    createCategory = async (req: Request, res: Response) => { res.status(201).json(await this.create.execute(req.body, getAuth(req))); };
    updateCategory = async (req: Request, res: Response) => { res.status(200).json(await this.update.execute(req.params.id as string, req.body, getAuth(req))); };
    deleteCategory = async (req: Request, res: Response) => { await this.remove.execute(req.params.id as string, getAuth(req)); res.status(204).send(); };
}

// Removing things. Each one is refused (409) when the history points at it, and tells you to deactivate it instead.
export class DeletionController {
    constructor(
        private readonly deleteStyle: DeleteStyleUsecase,
        private readonly deleteSku: DeleteSkuUsecase,
        private readonly deleteBranch: DeleteBranchUsecase,
        private readonly deleteUser: SoftDeleteUserUsecase,
    ) {}

    removeStyle = async (req: Request, res: Response) => { await this.deleteStyle.execute(req.params.id as string, getAuth(req)); res.status(204).send(); };
    removeSku = async (req: Request, res: Response) => { await this.deleteSku.execute(req.params.id as string, getAuth(req)); res.status(204).send(); };
    removeBranch = async (req: Request, res: Response) => { await this.deleteBranch.execute(req.params.id as string, getAuth(req)); res.status(204).send(); };
    removeUser = async (req: Request, res: Response) => { await this.deleteUser.execute(req.params.id as string, getAuth(req)); res.status(204).send(); };
}

export class SalesHistoryController {
    constructor(private readonly history: ListSalesHistoryUsecase) {}

    list = async (req: Request, res: Response) => {
        const result = await this.history.execute(
            { branchId: textParam(req, 'branchId'), from: textParam(req, 'from'), to: textParam(req, 'to'), limit: intParam(req, 'limit'), offset: intParam(req, 'offset') },
            getAuth(req),
        );
        res.setHeader('X-Total-Count', String(result.total));
        res.status(200).json({
            from: result.from, to: result.to,
            sales: result.rows.map((r) => ({
                id: r.id, reference: r.reference, branch: r.branch, soldAt: r.soldAt, businessDate: r.businessDate, soldBy: r.soldBy, status: r.status, channel: r.channel,
                items: r.items, total: r.total, discounts: r.totalDiscount, cash: r.cash, whish: r.whish,
            })),
        });
    };
}

export class WarehouseController {
    constructor(private readonly warehouse: GetWarehouseUsecase) {}
    get = async (_req: Request, res: Response) => { res.status(200).json(await this.warehouse.execute()); };
}

export class PermissionController {
    constructor(
        private readonly catalog: GetPermissionCatalogUsecase,
        private readonly get: GetUserPermissionsUsecase,
        private readonly set: SetUserPermissionsUsecase,
        private readonly getAccess: GetBranchAccessUsecase,
        private readonly setAccess: SetBranchAccessUsecase,
    ) {}

    getCatalog = async (req: Request, res: Response) => { res.status(200).json(this.catalog.execute(getAuth(req))); };
    getUserPermissions = async (req: Request, res: Response) => { res.status(200).json(await this.get.execute(req.params.id as string, getAuth(req))); };
    setUserPermissions = async (req: Request, res: Response) => { res.status(200).json(await this.set.execute(req.params.id as string, req.body, getAuth(req))); };
    getBranchAccess = async (req: Request, res: Response) => { res.status(200).json(await this.getAccess.execute(req.params.id as string, getAuth(req))); };
    setBranchAccess = async (req: Request, res: Response) => { res.status(200).json(await this.setAccess.execute(req.params.id as string, req.body, getAuth(req))); };
}

const toAdjustmentResponse = (a: AdjustmentView) => ({
    id: a.id, reference: a.reference, branch: a.branch, sku: a.sku, bucket: a.bucket, quantityDelta: a.quantityDelta, reason: a.reason, note: a.note, by: a.by, createdAt: a.createdAt, balanceAfter: a.balanceAfter,
});

export class AdjustmentController {
    constructor(private readonly create: CreateAdjustmentUsecase, private readonly list: ListAdjustmentsUsecase) {}

    createAdjustment = async (req: Request, res: Response) => {
        const result = await this.create.execute(req.body, req.header('idempotency-key'), getAuth(req));
        if (result.replayed) res.setHeader('Idempotent-Replay', 'true');
        res.status(201).json(toAdjustmentResponse(result.adjustment));
    };

    listAdjustments = async (req: Request, res: Response) => {
        const { items, total } = await this.list.execute(
            { branchId: textParam(req, 'branchId'), skuId: textParam(req, 'skuId'), reason: textParam(req, 'reason'), from: textParam(req, 'from'), to: textParam(req, 'to'), limit: intParam(req, 'limit'), offset: intParam(req, 'offset') },
            getAuth(req),
        );
        res.setHeader('X-Total-Count', String(total));
        res.status(200).json(items.map(toAdjustmentResponse));
    };
}
export class PlacesController {
    constructor(private readonly places: ListPlacesUsecase) {}
    list = async (req: Request, res: Response) => { res.status(200).json(await this.places.execute(getAuth(req))); };
}

export class GoodsReceiptController {
    constructor(private readonly create: CreateGoodsReceiptUsecase, private readonly get: GetGoodsReceiptUsecase, private readonly list: ListGoodsReceiptsUsecase) {}

    createReceipt = async (req: Request, res: Response) => {
        const result = await this.create.execute(req.body, req.header('idempotency-key'), getAuth(req));
        if (result.replayed) res.setHeader('Idempotent-Replay', 'true');
        res.status(201).json(result.receipt);
    };

    getReceipt = async (req: Request, res: Response) => { res.status(200).json(await this.get.execute(req.params.id as string, getAuth(req))); };

    listReceipts = async (req: Request, res: Response) => {
        const { items, total } = await this.list.execute(
            { supplier: textParam(req, 'supplier'), supplierId: textParam(req, 'supplierId'), invoiceNumber: textParam(req, 'invoiceNumber'), skuId: textParam(req, 'skuId'), from: textParam(req, 'from'), to: textParam(req, 'to'), limit: intParam(req, 'limit'), offset: intParam(req, 'offset') },
            getAuth(req),
        );
        res.setHeader('X-Total-Count', String(total));
        res.status(200).json(items);
    };
}

export class InvoiceController {
    constructor(
        private readonly create: CreateInvoiceUsecase,
        private readonly get: GetInvoiceUsecase,
        private readonly list: ListInvoicesUsecase,
        private readonly update: UpdateInvoiceUsecase,
        private readonly finalize: FinalizeInvoiceUsecase,
        private readonly voidInvoice: VoidInvoiceUsecase,
        private readonly remove: DeleteInvoiceUsecase,
        private readonly pdf: GetInvoicePdfUsecase,
    ) {}

    createInvoice = async (req: Request, res: Response) => { res.status(201).json(await this.create.execute(req.body, getAuth(req))); };
    getInvoice = async (req: Request, res: Response) => { res.status(200).json(await this.get.execute(req.params.id as string, getAuth(req))); };
    updateInvoice = async (req: Request, res: Response) => { res.status(200).json(await this.update.execute(req.params.id as string, req.body, getAuth(req))); };
    finalizeInvoice = async (req: Request, res: Response) => { res.status(200).json(await this.finalize.execute(req.params.id as string, getAuth(req))); };
    voidInvoiceById = async (req: Request, res: Response) => { res.status(200).json(await this.voidInvoice.execute(req.params.id as string, req.body, getAuth(req))); };
    deleteInvoice = async (req: Request, res: Response) => { await this.remove.execute(req.params.id as string, getAuth(req)); res.status(204).send(); };

    listInvoices = async (req: Request, res: Response) => {
        const { items, total } = await this.list.execute(
            { kind: textParam(req, 'kind'), status: textParam(req, 'status'), branchId: textParam(req, 'branchId'), transferId: textParam(req, 'transferId'), saleId: textParam(req, 'saleId'), search: textParam(req, 'search'), from: textParam(req, 'from'), to: textParam(req, 'to'), limit: intParam(req, 'limit'), offset: intParam(req, 'offset') },
            getAuth(req),
        );
        res.setHeader('X-Total-Count', String(total));
        res.status(200).json(items);
    };

    // the file itself: the browser must ask with the token (fetch, then show or save the blob), a plain link would not carry it
    invoicePdf = async (req: Request, res: Response) => {
        const { pdf, filename } = await this.pdf.execute(req.params.id as string, getAuth(req));
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
        res.setHeader('Cache-Control', 'no-store');
        res.status(200).send(pdf);
    };
}


import { CreateSupplierUsecase, GetSupplierUsecase, ListSuppliersUsecase, UpdateSupplierUsecase } from '../usecases/suppliers/SupplierUsecases';

export class SupplierController {
    constructor(private readonly create: CreateSupplierUsecase, private readonly get: GetSupplierUsecase, private readonly list: ListSuppliersUsecase, private readonly update: UpdateSupplierUsecase) {}

    createSupplier = async (req: Request, res: Response) => { res.status(201).json(await this.create.execute(req.body, getAuth(req))); };
    getSupplier = async (req: Request, res: Response) => { res.status(200).json(await this.get.execute(req.params.id as string, getAuth(req))); };
    updateSupplier = async (req: Request, res: Response) => { res.status(200).json(await this.update.execute(req.params.id as string, req.body, getAuth(req))); };
    listSuppliers = async (req: Request, res: Response) => {
        const { items, total } = await this.list.execute({ search: textParam(req, 'search'), active: textParam(req, 'active'), limit: intParam(req, 'limit'), offset: intParam(req, 'offset') }, getAuth(req));
        res.setHeader('X-Total-Count', String(total));
        res.status(200).json(items);
    };
}


import { GetSettingsUsecase, UpdateSettingsUsecase } from '../usecases/settings/SettingsUsecases';

export class SettingsController {
    constructor(private readonly get: GetSettingsUsecase, private readonly update: UpdateSettingsUsecase) {}
    getSettings = async (_req: Request, res: Response) => { res.status(200).json(await this.get.execute()); };
    updateSettings = async (req: Request, res: Response) => { res.status(200).json(await this.update.execute(req.body, getAuth(req))); };
}


import { AddCashMovementUsecase, CloseCashSessionUsecase, CorrectCashSessionUsecase, GetCashSessionUsecase, GetOpenCashSessionUsecase, HandoverCashSessionUsecase, ListCashSessionsUsecase, OpenCashSessionUsecase, ReviewCashSessionUsecase } from '../usecases/cash/CashSessionUsecases';

export class CashSessionController {
    constructor(
        private readonly open: OpenCashSessionUsecase, private readonly movement: AddCashMovementUsecase, private readonly handover: HandoverCashSessionUsecase, private readonly close: CloseCashSessionUsecase,
        private readonly correct: CorrectCashSessionUsecase, private readonly review: ReviewCashSessionUsecase, private readonly get: GetCashSessionUsecase, private readonly current: GetOpenCashSessionUsecase, private readonly list: ListCashSessionsUsecase,
    ) {}

    openSession = async (req: Request, res: Response) => { res.status(201).json(await this.open.execute(req.body, getAuth(req))); };
    addMovement = async (req: Request, res: Response) => {
        const { session, replayed } = await this.movement.execute(req.params.id as string, req.body, req.header('Idempotency-Key'), getAuth(req));
        if (replayed) res.setHeader('Idempotent-Replay', 'true');
        res.status(replayed ? 200 : 201).json(session);
    };
    handoverSession = async (req: Request, res: Response) => {
        const { session, replayed } = await this.handover.execute(req.params.id as string, req.body, req.header('Idempotency-Key'), getAuth(req));
        if (replayed) res.setHeader('Idempotent-Replay', 'true');
        res.status(replayed ? 200 : 201).json(session);
    };
    closeSession = async (req: Request, res: Response) => { res.status(200).json(await this.close.execute(req.params.id as string, req.body, getAuth(req))); };
    correctSession = async (req: Request, res: Response) => { res.status(201).json(await this.correct.execute(req.params.id as string, req.body, getAuth(req))); };
    reviewSession = async (req: Request, res: Response) => { res.status(200).json(await this.review.execute(req.params.id as string, req.body, getAuth(req))); };
    getSession = async (req: Request, res: Response) => { res.status(200).json(await this.get.execute(req.params.id as string, getAuth(req))); };
    currentSession = async (req: Request, res: Response) => { res.status(200).json(await this.current.execute(textParam(req, 'branchId'), getAuth(req))); };
    listSessions = async (req: Request, res: Response) => {
        const { items, total } = await this.list.execute({ branchId: textParam(req, 'branchId'), status: textParam(req, 'status'), review: textParam(req, 'review'), from: textParam(req, 'from'), to: textParam(req, 'to'), limit: intParam(req, 'limit'), offset: intParam(req, 'offset') }, getAuth(req));
        res.setHeader('X-Total-Count', String(total));
        res.status(200).json(items);
    };
}


import { GetProfitUsecase, SkuCostUsecases } from '../usecases/costs/CostUsecases';

export class CostController {
    constructor(private readonly costs: SkuCostUsecases, private readonly profit: GetProfitUsecase) {}
    getCost = async (req: Request, res: Response) => { res.status(200).json(await this.costs.get(req.params.id as string, getAuth(req))); };
    setCost = async (req: Request, res: Response) => { res.status(200).json(await this.costs.set(req.params.id as string, req.body, getAuth(req))); };
    getProfit = async (req: Request, res: Response) => { res.status(200).json(await this.profit.execute({ branchId: textParam(req, 'branchId'), from: textParam(req, 'from'), to: textParam(req, 'to') }, getAuth(req))); };
}


import { LinkExchangeUsecase, ApproveReturnUsecase, FindReturnableSaleUsecase, GetReturnUsecase, HandbackReturnUsecase, ListReturnsUsecase, PayRefundUsecase, ReceiveReturnUsecase, RejectReturnUsecase, ReleaseReturnUsecase, TakeCustodyUsecase } from '../usecases/returns/ReturnUsecases';

export class ReturnController {
    constructor(
        private readonly find: FindReturnableSaleUsecase, private readonly receive: ReceiveReturnUsecase, private readonly custody: TakeCustodyUsecase, private readonly approve: ApproveReturnUsecase,
        private readonly reject: RejectReturnUsecase, private readonly handback: HandbackReturnUsecase, private readonly release: ReleaseReturnUsecase, private readonly refund: PayRefundUsecase,
        private readonly get: GetReturnUsecase, private readonly list: ListReturnsUsecase, private readonly exchange: LinkExchangeUsecase,
    ) {}

    private reply(res: Response, result: { view: unknown; replayed: boolean }, created: number) {
        if (result.replayed) res.setHeader('Idempotent-Replay', 'true');
        res.status(created).json(result.view);
    }
    eligible = async (req: Request, res: Response) => { res.status(200).json(await this.find.execute(textParam(req, 'sale'), getAuth(req))); };
    receiveReturn = async (req: Request, res: Response) => this.reply(res, await this.receive.execute(req.body, req.header('Idempotency-Key'), getAuth(req)), 201);
    takeCustody = async (req: Request, res: Response) => { res.status(200).json(await this.custody.execute(req.params.id as string, getAuth(req))); };
    approveReturn = async (req: Request, res: Response) => this.reply(res, await this.approve.execute(req.params.id as string, req.body, req.header('Idempotency-Key'), getAuth(req)), 200);
    rejectReturn = async (req: Request, res: Response) => { res.status(200).json(await this.reject.execute(req.params.id as string, req.body, getAuth(req))); };
    handbackReturn = async (req: Request, res: Response) => { res.status(200).json(await this.handback.execute(req.params.id as string, req.body, getAuth(req))); };
    releaseReturn = async (req: Request, res: Response) => this.reply(res, await this.release.execute(req.params.id as string, req.body, req.header('Idempotency-Key'), getAuth(req)), 200);
    payRefund = async (req: Request, res: Response) => this.reply(res, await this.refund.execute(req.params.id as string, req.body, req.header('Idempotency-Key'), getAuth(req)), 201);
    linkExchange = async (req: Request, res: Response) => { res.status(200).json(await this.exchange.execute(req.params.id as string, req.body, getAuth(req))); };
    getReturn = async (req: Request, res: Response) => { res.status(200).json(await this.get.execute(req.params.id as string, getAuth(req))); };
    listReturns = async (req: Request, res: Response) => {
        const { items, total } = await this.list.execute({ branchId: textParam(req, 'branchId'), saleId: textParam(req, 'saleId'), status: textParam(req, 'status'), from: textParam(req, 'from'), to: textParam(req, 'to'), limit: intParam(req, 'limit'), offset: intParam(req, 'offset') }, getAuth(req));
        res.setHeader('X-Total-Count', String(total));
        res.status(200).json(items);
    };
}
