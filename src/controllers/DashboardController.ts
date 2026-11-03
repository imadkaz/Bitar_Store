import { Request, Response } from 'express';
import { getAuth } from '../middlewares/Authenticate';
import { GetDashboardOverviewUsecase } from '../usecases/dashboard/GetDashboardOverviewUsecase';
import { textParam } from './query';

export class DashboardController {
    constructor(private readonly overview: GetDashboardOverviewUsecase) {}

    getOverview = async (req: Request, res: Response) => {
        const data = await this.overview.execute({ branchId: textParam(req, 'branchId') }, getAuth(req));
        res.status(200).json(data);
    };
}
