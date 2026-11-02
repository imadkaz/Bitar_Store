import { RequestHandler, Router } from 'express';
import { TransferController } from '../controllers/TransferController';
import { asyncHandler } from '../middlewares/asyncHandler';
import { requirePermission } from '../middlewares/Authenticate';

export const TransferRoutes = (controller: TransferController, authenticate: RequestHandler): Router => {
    const route = Router();
    route.get('/', authenticate, asyncHandler(controller.list));                   // ?branchId=...&status=...
    route.post('/', authenticate, asyncHandler(controller.create));                // the use case checks: send from your place, or ask the warehouse to restock yours
    route.get('/:id', authenticate, asyncHandler(controller.get));
    route.post('/:id/dispatch', authenticate, requirePermission('transfers.dispatch'), asyncHandler(controller.dispatch));
    route.post('/:id/receive', authenticate, requirePermission('transfers.receive'), asyncHandler(controller.receive));
    route.post('/:id/resolve', authenticate, requirePermission('transfers.dispatch'), asyncHandler(controller.resolve));
    route.post('/:id/cancel', authenticate, asyncHandler(controller.cancel));       // the sender, or the person who asked
    return route;
};
