import { RequestHandler, Router } from 'express';
import { SaleController } from '../controllers/SaleController';
import { asyncHandler } from '../middlewares/asyncHandler';
import { requirePermission } from '../middlewares/Authenticate';

export const SaleRoutes = (controller: SaleController, authenticate: RequestHandler): Router => {
    const route = Router();
    route.post('/', authenticate, requirePermission('sales.create'), asyncHandler(controller.createSale));
    route.get('/', authenticate, asyncHandler(controller.listSales));         // ?branchId=...&date=2026-10-27
    route.get('/:id', authenticate, asyncHandler(controller.getSale));
    return route;
};
