import { RequestHandler, Router } from 'express';
import { SkuController } from '../controllers/SkuController';
import { asyncHandler } from '../middlewares/asyncHandler';
import { requirePermission } from '../middlewares/Authenticate';

export const SkuRoutes = (controller: SkuController, authenticate: RequestHandler): Router => {
    const route = Router();
    route.get('/', authenticate, asyncHandler(controller.listSkus));
    route.post('/', authenticate, requirePermission('catalog.create'), asyncHandler(controller.createSku));
    route.get('/lookup', authenticate, asyncHandler(controller.lookupSku));   // before '/:id', or "lookup" would be read as an id
    route.get('/:id', authenticate, asyncHandler(controller.getSku));
    route.patch('/:id', authenticate, requirePermission('catalog.create'), asyncHandler(controller.updateSku));
    route.put('/:id/price', authenticate, requirePermission('catalog.create'), asyncHandler(controller.changePrice));
    route.get('/:id/price-history', authenticate, requirePermission('catalog.create'), asyncHandler(controller.priceHistory));
    route.post('/:id/barcodes', authenticate, requirePermission('catalog.create'), asyncHandler(controller.addBarcode));
    return route;
};
