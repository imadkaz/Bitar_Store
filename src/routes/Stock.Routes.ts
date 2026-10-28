import { RequestHandler, Router } from 'express';
import { StockController } from '../controllers/StockController';
import { asyncHandler } from '../middlewares/asyncHandler';
import { requirePermission } from '../middlewares/Authenticate';

export const StockRoutes = (controller: StockController, authenticate: RequestHandler): Router => {
    const route = Router();
    route.get('/', authenticate, asyncHandler(controller.listStock));          // ?branchId=...&search=...
    route.post('/opening', authenticate, requirePermission('adjustments.create'), asyncHandler(controller.setOpening));
    return route;
};
