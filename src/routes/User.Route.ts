// src/routes/User.Routes.ts
import { RequestHandler, Router } from 'express';
import { UserController } from '../controllers/User.Controller';
import { asyncHandler } from '../middlewares/asyncHandler';
import { requireRole } from '../middlewares/Authenticate';
import { UserRole } from '../models/User.model';

export const UserRoutes = (controller: UserController, authenticate: RequestHandler): Router => {
    const route = Router();

    // everything under /users: first "who are you?", then "are you an admin?"
    route.use(authenticate, requireRole(UserRole.ADMIN));

    route.post('/', asyncHandler(controller.createUser));
    route.get('/', asyncHandler(controller.listUsers));
    route.patch('/:id', asyncHandler(controller.updateUser));   // PATCH = partial update. No delete: users are deactivated.
    route.put('/:id/branches/:branchId', asyncHandler(controller.grantBranch));
    route.delete('/:id/branches/:branchId', asyncHandler(controller.revokeBranch));
    return route;
};