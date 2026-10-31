import { RequestHandler, Router } from 'express';
import { AuditController, ReorderLevelController, ReportController, StockInsightController } from '../controllers/InsightControllers';
import { asyncHandler } from '../middlewares/asyncHandler';
import { requirePermission, requireRole } from '../middlewares/Authenticate';
import { UserRole } from '../models/User.model';

// mounted at /stock, next to the existing stock routes
export const StockInsightRoutes = (controller: StockInsightController, authenticate: RequestHandler): Router => {
    const route = Router();
    route.get('/overview', authenticate, requireRole(UserRole.ADMIN), asyncHandler(controller.getOverview));       // every place, admin only
    route.get('/movements', authenticate, requirePermission('adjustments.create'), asyncHandler(controller.listMovements));
    return route;
};

export const ReorderLevelRoutes = (controller: ReorderLevelController, authenticate: RequestHandler): Router => {
    const route = Router();
    route.get('/', authenticate, requirePermission('adjustments.create'), asyncHandler(controller.listLevels));
    route.put('/', authenticate, requirePermission('adjustments.create'), asyncHandler(controller.setLevel));
    route.put('/by-style', authenticate, requirePermission('adjustments.create'), asyncHandler(controller.setLevelForStyle));
    route.delete('/:id', authenticate, requirePermission('adjustments.create'), asyncHandler(controller.deleteLevel));
    return route;
};

export const ReplenishmentRoutes = (controller: ReportController, authenticate: RequestHandler): Router => {
    const route = Router();
    route.get('/suggestions', authenticate, requirePermission('adjustments.create'), asyncHandler(controller.getSuggestions));
    return route;
};

export const ReportRoutes = (controller: ReportController, authenticate: RequestHandler): Router => {
    const route = Router();
    route.get('/sales-summary', authenticate, requirePermission('reports.financial'), asyncHandler(controller.getSalesSummary));
    route.get('/top-skus', authenticate, requirePermission('reports.financial'), asyncHandler(controller.getTopSkus));
    return route;
};

export const AuditRoutes = (controller: AuditController, authenticate: RequestHandler): Router => {
    const route = Router();
    route.get('/', authenticate, requireRole(UserRole.ADMIN), asyncHandler(controller.listEvents));
    return route;
};
