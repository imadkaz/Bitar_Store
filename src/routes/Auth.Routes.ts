import { RequestHandler, Router } from 'express';
import { AuthController } from '../controllers/AuthController';
import { asyncHandler } from '../middlewares/asyncHandler';

export const AuthRoutes = (controller: AuthController, authenticate: RequestHandler): Router => {
    const route = Router();
    route.post('/login', asyncHandler(controller.login));            // public: this is how you get a token
    route.get('/me', authenticate, asyncHandler(controller.me));     // needs a token
    return route;
};
