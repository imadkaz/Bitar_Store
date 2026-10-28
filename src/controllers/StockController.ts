import { Request, Response } from 'express';
import { getAuth } from '../middlewares/Authenticate';
import { ListStockUsecase } from '../usecases/stock/ListStockUsecase';
import { SetOpeningStockUsecase } from '../usecases/stock/SetOpeningStockUsecase';
import { ValidationError } from '../utils/exeptions/ValidationError';
import { isUuid } from '../utils/uuid';
import { boolParam, intParam, textParam } from './query';
import { toStockItemResponse } from './responses';

export class StockController {
    constructor(
        private readonly listStockUsecase: ListStockUsecase,
        private readonly setOpeningStockUsecase: SetOpeningStockUsecase,
    ) {}

    listStock = async (req: Request, res: Response) => {
        const styleId = textParam(req, 'styleId');
        if (styleId !== undefined && !isUuid(styleId)) throw new ValidationError('styleId must be a valid id');
        const items = await this.listStockUsecase.execute(
            { branchId: textParam(req, 'branchId'), search: textParam(req, 'search'), styleId, activeOnly: boolParam(req, 'activeOnly'), limit: intParam(req, 'limit'), offset: intParam(req, 'offset') },
            getAuth(req),
        );
        res.status(200).json(items.map(toStockItemResponse));
    };

    // POST /stock/opening  with the header  Idempotency-Key
    setOpening = async (req: Request, res: Response) => {
        const result = await this.setOpeningStockUsecase.execute(req.body, req.header('idempotency-key')!, getAuth(req));
        if (result.replayed) res.setHeader('Idempotent-Replay', 'true');
        res.status(201).json({ batchId: result.batchId, lines: result.lines });
    };
}
