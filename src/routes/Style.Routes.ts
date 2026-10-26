import { RequestHandler, Router } from 'express';
import { StyleController } from '../controllers/StyleController';
import { asyncHandler } from '../middlewares/asyncHandler';
import { requirePermission } from '../middlewares/Authenticate';

// Reading the catalog needs a login only (every employee must be able to search and scan).
// Changing it needs the 'catalog.create' permission (admins and managers by default).
export const StyleRoutes = (controller: StyleController, authenticate: RequestHandler): Router => {
    const route = Router();
    route.get('/', authenticate, asyncHandler(controller.listStyles));
    route.post('/', authenticate, requirePermission('catalog.create'), asyncHandler(controller.createStyle));
    route.get('/:id', authenticate, asyncHandler(controller.getStyle));
    route.patch('/:id', authenticate, requirePermission('catalog.create'), asyncHandler(controller.updateStyle));
    return route;
};
