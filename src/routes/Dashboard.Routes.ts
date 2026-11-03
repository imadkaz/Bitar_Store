import { RequestHandler, Router } from 'express';
import { DashboardController } from '../controllers/DashboardController';
import { asyncHandler } from '../middlewares/asyncHandler';
import { requirePermission } from '../middlewares/Authenticate';

export const DashboardRoutes = (controller: DashboardController, authenticate: RequestHandler): Router => {
    const route = Router();
    route.get('/overview', authenticate, requirePermission('reports.financial'), asyncHandler(controller.getOverview));
    return route;
};
