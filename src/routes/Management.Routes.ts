import { RequestHandler, Router } from 'express';
import { CategoryController, DeletionController, GoodsReceiptController, PermissionController, SalesHistoryController, WarehouseController } from '../controllers/ManagementControllers';
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

export const GoodsReceiptRoutes = (controller: GoodsReceiptController, authenticate: RequestHandler): Router =>
    Router()
        .get('/', authenticate, asyncHandler(controller.listReceipts))
        .post('/', authenticate, asyncHandler(controller.createReceipt))
        .get('/:id', authenticate, asyncHandler(controller.getReceipt));
