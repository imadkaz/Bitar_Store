import { Request, Response } from 'express';
import { getAuth } from '../middlewares/Authenticate';
import { DeleteReorderLevelUsecase, ListReorderLevelsUsecase, SetReorderLevelForStyleUsecase, SetReorderLevelUsecase } from '../usecases/reorder/ReorderLevelUsecases';
import {
    GetReplenishmentSuggestionsUsecase, GetSalesSummaryUsecase, GetStockOverviewUsecase, GetTopSkusUsecase, ListAuditEventsUsecase, ListStockMovementsUsecase,
} from '../usecases/insight/InsightUsecases';
import { NotFoundError } from '../utils/exeptions/NotFoundError';
import { ValidationError } from '../utils/exeptions/ValidationError';
import { isUuid } from '../utils/uuid';
import { boolParam, intParam, textParam } from './query';
import {
    toAuditResponse, toMovementResponse, toOverviewResponse, toReorderLevelResponse, toSalesSummaryResponse, toSuggestionsResponse, toTopSkuResponse,
} from './responses';

// The admin's overview of every place, and the history of one place.
export class StockInsightController {
    constructor(private readonly overview: GetStockOverviewUsecase, private readonly movements: ListStockMovementsUsecase) {}

    getOverview = async (req: Request, res: Response) => {
        const styleId = textParam(req, 'styleId');
        if (styleId !== undefined && !isUuid(styleId)) throw new ValidationError('styleId must be a valid id');
        const result = await this.overview.execute(
            { search: textParam(req, 'search'), styleId, activeOnly: boolParam(req, 'activeOnly'), limit: intParam(req, 'limit'), offset: intParam(req, 'offset') },
            getAuth(req),
        );
        res.status(200).json(toOverviewResponse(result));
    };

    listMovements = async (req: Request, res: Response) => {
        const rows = await this.movements.execute(
            { branchId: textParam(req, 'branchId'), skuId: textParam(req, 'skuId'), type: textParam(req, 'type'), from: textParam(req, 'from'), to: textParam(req, 'to'), limit: intParam(req, 'limit'), offset: intParam(req, 'offset') },
            getAuth(req),
        );
        res.status(200).json(rows.map(toMovementResponse));
    };
}

export class ReorderLevelController {
    constructor(
        private readonly list: ListReorderLevelsUsecase,
        private readonly set: SetReorderLevelUsecase,
        private readonly setForStyle: SetReorderLevelForStyleUsecase,
        private readonly remove: DeleteReorderLevelUsecase,
    ) {}

    listLevels = async (req: Request, res: Response) => {
        const rows = await this.list.execute({ branchId: textParam(req, 'branchId'), search: textParam(req, 'search'), limit: intParam(req, 'limit'), offset: intParam(req, 'offset') }, getAuth(req));
        res.status(200).json(rows.map(toReorderLevelResponse));
    };

    setLevel = async (req: Request, res: Response) => {
        res.status(200).json(toReorderLevelResponse(await this.set.execute(req.body, getAuth(req))));
    };

    setLevelForStyle = async (req: Request, res: Response) => {
        res.status(200).json(await this.setForStyle.execute(req.body, getAuth(req)));
    };

    deleteLevel = async (req: Request, res: Response) => {
        const id = req.params.id as string;
        if (!isUuid(id)) throw new NotFoundError('Minimum not found');
        await this.remove.execute(id, getAuth(req));
        res.status(204).send();
    };
}

export class ReportController {
    constructor(
        private readonly suggestions: GetReplenishmentSuggestionsUsecase,
        private readonly salesSummary: GetSalesSummaryUsecase,
        private readonly topSkus: GetTopSkusUsecase,
    ) {}

    getSuggestions = async (req: Request, res: Response) => {
        res.status(200).json(toSuggestionsResponse(await this.suggestions.execute({ branchId: textParam(req, 'branchId') }, getAuth(req))));
    };

    getSalesSummary = async (req: Request, res: Response) => {
        res.status(200).json(toSalesSummaryResponse(await this.salesSummary.execute({ branchId: textParam(req, 'branchId'), from: textParam(req, 'from'), to: textParam(req, 'to') }, getAuth(req))));
    };

    getTopSkus = async (req: Request, res: Response) => {
        const result = await this.topSkus.execute({ branchId: textParam(req, 'branchId'), from: textParam(req, 'from'), to: textParam(req, 'to'), limit: intParam(req, 'limit') }, getAuth(req));
        res.status(200).json({ from: result.from, to: result.to, rows: result.rows.map(toTopSkuResponse) });
    };
}

export class AuditController {
    constructor(private readonly list: ListAuditEventsUsecase) {}

    listEvents = async (req: Request, res: Response) => {
        const rows = await this.list.execute(
            {
                entityType: textParam(req, 'entityType'), entityId: textParam(req, 'entityId'), actorId: textParam(req, 'actorId'), branchId: textParam(req, 'branchId'),
                from: textParam(req, 'from'), to: textParam(req, 'to'), limit: intParam(req, 'limit'), offset: intParam(req, 'offset'),
            },
            getAuth(req),
        );
        res.status(200).json(rows.map(toAuditResponse));
    };
}
