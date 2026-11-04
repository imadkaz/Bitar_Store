import { Request, Response } from 'express';
import { getAuth } from '../middlewares/Authenticate';
import { ListSalesHistoryUsecase } from '../usecases/sales/ListSalesHistoryUsecase';
import {
    CreateCategoryUsecase, GetBranchAccessUsecase, SetBranchAccessUsecase, GetPermissionCatalogUsecase, GetUserPermissionsUsecase, SetUserPermissionsUsecase, DeleteBranchUsecase, DeleteCategoryUsecase, DeleteSkuUsecase, DeleteStyleUsecase, SoftDeleteUserUsecase, GetWarehouseUsecase, ListCategoriesUsecase, UpdateCategoryUsecase,
} from '../usecases/management/ManagementUsecases';
import { boolParam, intParam, textParam } from './query';
import { CreateGoodsReceiptUsecase, GetGoodsReceiptUsecase, ListGoodsReceiptsUsecase } from '../usecases/goodsreceipts/GoodsReceiptUsecases';

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
            { supplier: textParam(req, 'supplier'), invoiceNumber: textParam(req, 'invoiceNumber'), skuId: textParam(req, 'skuId'), from: textParam(req, 'from'), to: textParam(req, 'to'), limit: intParam(req, 'limit'), offset: intParam(req, 'offset') },
            getAuth(req),
        );
        res.setHeader('X-Total-Count', String(total));
        res.status(200).json(items);
    };
}