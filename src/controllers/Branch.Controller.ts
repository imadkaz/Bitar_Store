import { Request, Response } from 'express';
import { getAuth } from '../middlewares/Authenticate';
import { CreateBranchUsecase } from '../usecases/branch/CreateBranchUsecase';
import { ListBranchesUsecase } from '../usecases/branch/ListBranchesUsecase';
import { toBranchResponse } from './responses';

export class BranchController {
    constructor(
        private readonly createBranchUsecase: CreateBranchUsecase,
        private readonly listBranchesUsecase: ListBranchesUsecase,
    ) {}

    createBranch = async (req: Request, res: Response) => {
        const input = req.body ?? {};
        const branch = await this.createBranchUsecase.execute(
            { code: input.code, name: input.name },
            getAuth(req).user.getId(),
        );
        res.status(201).json(toBranchResponse(branch));
    };

    listBranches = async (req: Request, res: Response) => {
        const branches = await this.listBranchesUsecase.execute(getAuth(req));
        res.status(200).json(branches.map(toBranchResponse));
    };
}
