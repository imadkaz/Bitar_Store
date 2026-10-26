import { RequestHandler, Router } from 'express';
import { SkuController } from '../controllers/SkuController';
import { asyncHandler } from '../middlewares/asyncHandler';
import { requirePermission } from '../middlewares/Authenticate';

export const BarcodeRoutes = (controller: SkuController, authenticate: RequestHandler): Router => {
    const route = Router();
    route.delete('/:id', authenticate, requirePermission('catalog.create'), asyncHandler(controller.removeBarcode));
    return route;
};
