import { RequestHandler, Router } from 'express';
import { BranchController } from '../controllers/Branch.Controller';
import { asyncHandler } from '../middlewares/asyncHandler';
import { requireRole } from '../middlewares/Authenticate';
import { UserRole } from '../models/User.model';

export const BranchRoutes = (controller: BranchController, authenticate: RequestHandler): Router => {
    const route = Router();
    route.get('/', authenticate, asyncHandler(controller.listBranches));
    route.post('/', authenticate, requireRole(UserRole.ADMIN), asyncHandler(controller.createBranch));
    return route;
};
