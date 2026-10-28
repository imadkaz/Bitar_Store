import { Request, Response } from 'express';
import { getAuth } from '../middlewares/Authenticate';
import { CreateSaleUsecase } from '../usecases/sales/CreateSaleUsecase';
import { GetSaleUsecase } from '../usecases/sales/GetSaleUsecase';
import { ListSalesUsecase } from '../usecases/sales/ListSalesUsecase';
import { NotFoundError } from '../utils/exeptions/NotFoundError';
import { isUuid } from '../utils/uuid';
import { intParam, textParam } from './query';
import { toSaleResponse } from './responses';

export class SaleController {
    constructor(
        private readonly createSaleUsecase: CreateSaleUsecase,
        private readonly getSaleUsecase: GetSaleUsecase,
        private readonly listSalesUsecase: ListSalesUsecase,
    ) {}

    // POST /sales  with the header  Idempotency-Key: <a new random id for each sale>
    createSale = async (req: Request, res: Response) => {
        const { sale, replayed } = await this.createSaleUsecase.execute(req.body, req.header('idempotency-key')!, getAuth(req));
        if (replayed) res.setHeader('Idempotent-Replay', 'true');    // the same request again: nothing new was done
        res.status(201).json(toSaleResponse(sale));
    };

    getSale = async (req: Request, res: Response) => {
        const id = req.params.id as string;
        if (!isUuid(id)) throw new NotFoundError('Sale not found');
        res.status(200).json(toSaleResponse(await this.getSaleUsecase.execute(id, getAuth(req))));
    };

    listSales = async (req: Request, res: Response) => {
        const { businessDate, sales } = await this.listSalesUsecase.execute(
            { branchId: textParam(req, 'branchId'), date: textParam(req, 'date'), limit: intParam(req, 'limit'), offset: intParam(req, 'offset') },
            getAuth(req),
        );
        res.status(200).json({ businessDate, sales: sales.map(toSaleResponse) });
    };
}
