// src/Controllers/UserController.ts
import { Request, Response } from 'express';
import { CreateUserUsecase } from '../usecases/user/CreateUserUsecase';
import { ListUsersUsecase } from '../usecases/user/ListUsersUsecase';
import { UpdateUserUsecase } from '../usecases/user/UpdateUserUsecase';
import { NotFoundError } from '../utils/exeptions/NotFoundError';
import { isUuid } from '../utils/uuid';
import { toUserResponse } from './responses';
import { getAuth } from '../middlewares/Authenticate';
import { RevokeBranchAccessUsecase } from '../usecases/user/RevokeBranchAccessUsecase';
import { GrantBranchAccessUsecase } from '../usecases/user/GrantBranchAccessUsecase';

export class UserController {
    constructor(
        private readonly createUserUsecase: CreateUserUsecase,
        private readonly listUsersUsecase: ListUsersUsecase,
        private readonly updateUserUsecase: UpdateUserUsecase,
        private readonly grantBranchAccessUsecase: GrantBranchAccessUsecase,
        private readonly revokeBranchAccessUsecase: RevokeBranchAccessUsecase,
    ) {}

    createUser = async (req: Request, res: Response) => {
        const input = req.body ?? {};   // fields are picked one by one: the client can't inject anything else
        const user = await this.createUserUsecase.execute(
            { email: input.email, password: input.password, fullName: input.fullName, role: input.role },
            getAuth(req).user.getId(),   // who is creating this user (saved as created_by)
        );
        res.status(201).json(toUserResponse(user));
    };

    listUsers = async (_req: Request, res: Response) => {
        const users = await this.listUsersUsecase.execute();
        res.status(200).json(users.map(toUserResponse));
    };

    updateUser = async (req: Request, res: Response) => {
        const id = req.params.id as string;
        if (!isUuid(id)) throw new NotFoundError('User not found');   // a non-uuid would crash the query (500)

        const input = req.body ?? {};
        const user = await this.updateUserUsecase.execute(
            {
                id,
                email: input.email,
                password: input.password,
                fullName: input.fullName,
                role: input.role,
                isActive: input.isActive,
            },
            getAuth(req).user.getId(),
        );
        res.status(200).json(toUserResponse(user));
    };

        grantBranch = async (req: Request, res: Response) => {
        await this.grantBranchAccessUsecase.execute(
            req.params.id as string,
            req.params.branchId as string,
            getAuth(req).user.getId(),
        );
        res.status(204).send();
    };

    revokeBranch = async (req: Request, res: Response) => {
        await this.revokeBranchAccessUsecase.execute(req.params.id as string, req.params.branchId as string);
        res.status(204).send();
    };
}