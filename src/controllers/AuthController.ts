import { Request, Response } from 'express';
import { getAuth } from '../middlewares/Authenticate';
import { LoginUsecase } from '../usecases/auth/LoginUsecase';
import { toUserResponse } from './responses';

export class AuthController {
    constructor(private readonly loginUsecase: LoginUsecase) {}

    login = async (req: Request, res: Response) => {
        const input = req.body ?? {};
        const { token, user } = await this.loginUsecase.execute({ email: input.email, password: input.password });
        res.status(200).json({ token, user: toUserResponse(user) });
    };

    // "who am I, what may I do": the frontend calls this after login and on page reload
    me = async (req: Request, res: Response) => {
        const auth = getAuth(req);
        res.status(200).json({
            user: toUserResponse(auth.user),
            permissions: auth.getPermissions(),
            branchIds: auth.getBranchIds(),
            canViewCosts: auth.canViewCosts(),
        });
    };
}
