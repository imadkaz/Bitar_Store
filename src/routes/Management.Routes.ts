import { RequestHandler, Router } from 'express';
import { AdjustmentController, CategoryController, DeletionController, GoodsReceiptController, InvoiceController, PermissionController, PlacesController, SalesHistoryController, WarehouseController } from '../controllers/ManagementControllers';
import { asyncHandler } from '../middlewares/asyncHandler';

// Each of these routers is mounted BEFORE the existing one on the same prefix and answers only what is new (a DELETE, /history):
// everything else falls through to the existing router. The use cases check the permissions.
export const CategoryRoutes = (controller: CategoryController, authenticate: RequestHandler): Router => {
    const route = Router();
    route.get('/', authenticate, asyncHandler(controller.listCategories));
    route.post('/', authenticate, asyncHandler(controller.createCategory));
    route.patch('/:id', authenticate, asyncHandler(controller.updateCategory));
    route.delete('/:id', authenticate, asyncHandler(controller.deleteCategory));
    return route;
};

export const DeleteRoutes = (controller: DeletionController, authenticate: RequestHandler) => ({
    styles: Router().delete('/:id', authenticate, asyncHandler(controller.removeStyle)),
    skus: Router().delete('/:id', authenticate, asyncHandler(controller.removeSku)),
    branches: Router().delete('/:id', authenticate, asyncHandler(controller.removeBranch)),
    users: Router().delete('/:id', authenticate, asyncHandler(controller.removeUser)),
});

export const SalesHistoryRoutes = (controller: SalesHistoryController, authenticate: RequestHandler): Router => Router().get('/', authenticate, asyncHandler(controller.list));

export const WarehouseRoutes = (controller: WarehouseController, authenticate: RequestHandler): Router => Router().get('/', authenticate, asyncHandler(controller.get));

export const PermissionRoutes = (controller: PermissionController, authenticate: RequestHandler) => ({
    catalog: Router().get('/', authenticate, asyncHandler(controller.getCatalog)),
    users: Router()
        .get('/:id/permissions', authenticate, asyncHandler(controller.getUserPermissions))
        .put('/:id/permissions', authenticate, asyncHandler(controller.setUserPermissions))
        .get('/:id/branch-access', authenticate, asyncHandler(controller.getBranchAccess))
        .put('/:id/branch-access', authenticate, asyncHandler(controller.setBranchAccess)),
});


export const AdjustmentRoutes = (controller: AdjustmentController, authenticate: RequestHandler): Router =>
    Router()
        .get('/', authenticate, asyncHandler(controller.listAdjustments))
        .post('/', authenticate, asyncHandler(controller.createAdjustment));

export const PlacesRoutes = (controller: PlacesController, authenticate: RequestHandler): Router => Router().get('/', authenticate, asyncHandler(controller.list));

export const GoodsReceiptRoutes = (controller: GoodsReceiptController, authenticate: RequestHandler): Router =>
    Router()
        .get('/', authenticate, asyncHandler(controller.listReceipts))
        .post('/', authenticate, asyncHandler(controller.createReceipt))
        .get('/:id', authenticate, asyncHandler(controller.getReceipt));


export const InvoiceRoutes = (controller: InvoiceController, authenticate: RequestHandler): Router =>
    Router()
        .get('/', authenticate, asyncHandler(controller.listInvoices))
        .post('/', authenticate, asyncHandler(controller.createInvoice))
        .get('/:id/pdf', authenticate, asyncHandler(controller.invoicePdf))
        .post('/:id/finalize', authenticate, asyncHandler(controller.finalizeInvoice))
        .post('/:id/void', authenticate, asyncHandler(controller.voidInvoiceById))
        .get('/:id', authenticate, asyncHandler(controller.getInvoice))
        .patch('/:id', authenticate, asyncHandler(controller.updateInvoice))
        .delete('/:id', authenticate, asyncHandler(controller.deleteInvoice));


import { SupplierController } from '../controllers/ManagementControllers';

// mounted at /suppliers: the use cases check who may
export const SupplierRoutes = (controller: SupplierController, authenticate: RequestHandler): Router =>
    Router()
        .get('/', authenticate, asyncHandler(controller.listSuppliers))
        .post('/', authenticate, asyncHandler(controller.createSupplier))
        .get('/:id', authenticate, asyncHandler(controller.getSupplier))
        .patch('/:id', authenticate, asyncHandler(controller.updateSupplier));


import { SettingsController } from '../controllers/ManagementControllers';

// mounted at /settings: everyone signed in reads, an admin or a manager changes
export const SettingsRoutes = (controller: SettingsController, authenticate: RequestHandler): Router =>
    Router()
        .get('/', authenticate, asyncHandler(controller.getSettings))
        .put('/', authenticate, asyncHandler(controller.updateSettings));


import { CashSessionController } from '../controllers/ManagementControllers';

// mounted at /cash-sessions: the use cases check the permission and the branch
export const CashSessionRoutes = (controller: CashSessionController, authenticate: RequestHandler): Router =>
    Router()
        .get('/', authenticate, asyncHandler(controller.listSessions))
        .post('/', authenticate, asyncHandler(controller.openSession))
        .get('/current', authenticate, asyncHandler(controller.currentSession))
        .get('/:id', authenticate, asyncHandler(controller.getSession))
        .post('/:id/movements', authenticate, asyncHandler(controller.addMovement))
        .post('/:id/handover', authenticate, asyncHandler(controller.handoverSession))
        .post('/:id/close', authenticate, asyncHandler(controller.closeSession))
        .post('/:id/corrections', authenticate, asyncHandler(controller.correctSession))
        .post('/:id/review', authenticate, asyncHandler(controller.reviewSession));


import { CostController } from '../controllers/ManagementControllers';

// the cost of a piece (admin or manager) and the profit report: /costs/skus/:id and /costs/profit
export const CostRoutes = (controller: CostController, authenticate: RequestHandler): Router =>
    Router()
        .get('/profit', authenticate, asyncHandler(controller.getProfit))
        .get('/skus/:id', authenticate, asyncHandler(controller.getCost))
        .put('/skus/:id', authenticate, asyncHandler(controller.setCost));
