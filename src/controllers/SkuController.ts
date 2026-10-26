import { Request, Response } from 'express';
import { getAuth } from '../middlewares/Authenticate';
import { AddBarcodeUsecase } from '../usecases/barcodes/AddBarcodeUsecase';
import { ChangeSkuPriceUsecase } from '../usecases/skus/ChangeSkuPriceUsecase';
import { CreateSkuUsecase } from '../usecases/skus/CreateSkuUsecase';
import { GetPriceHistoryUsecase } from '../usecases/skus/GetPriceHistoryUsecase';
import { GetSkuUsecase } from '../usecases/skus/GetSkuUsecase';
import { ListSkusUsecase } from '../usecases/skus/ListSkusUsecase';
import { LookupSkuUsecase } from '../usecases/skus/LookupSkuUsecase';
import { RemoveBarcodeUsecase } from '../usecases/barcodes/RemoveBarcodeUsecase';
import { UpdateSkuUsecase } from '../usecases/skus/UpdateSkuUsecase';
import { NotFoundError } from '../utils/exeptions/NotFoundError';
import { ValidationError } from '../utils/exeptions/ValidationError';
import { isUuid } from '../utils/uuid';
import { boolParam, intParam, textParam } from './query';
import { toBarcodeResponse, toPriceChangeResponse, toSkuDetailResponse, toSkuResponse, toSkuWithStyleResponse } from './responses';

export class SkuController {
    constructor(
        private readonly createSkuUsecase: CreateSkuUsecase,
        private readonly listSkusUsecase: ListSkusUsecase,
        private readonly getSkuUsecase: GetSkuUsecase,
        private readonly lookupSkuUsecase: LookupSkuUsecase,
        private readonly updateSkuUsecase: UpdateSkuUsecase,
        private readonly changeSkuPriceUsecase: ChangeSkuPriceUsecase,
        private readonly getPriceHistoryUsecase: GetPriceHistoryUsecase,
        private readonly addBarcodeUsecase: AddBarcodeUsecase,
        private readonly removeBarcodeUsecase: RemoveBarcodeUsecase,
    ) {}

    createSku = async (req: Request, res: Response) => {
        const input = req.body ?? {};
        if (!isUuid(input.styleId)) throw new ValidationError('styleId must be the id of an existing style');
        const sku = await this.createSkuUsecase.execute(
            {
                styleId: input.styleId,
                skuCode: input.skuCode,
                size: input.size,
                color: input.color,
                standardPrice: input.standardPrice,
                currency: input.currency,
            },
            getAuth(req).user.getId(),
        );
        res.status(201).json(toSkuResponse(sku));
    };

    listSkus = async (req: Request, res: Response) => {
        const styleId = textParam(req, 'styleId');
        if (styleId !== undefined && !isUuid(styleId)) throw new ValidationError('styleId must be a valid id');
        const skus = await this.listSkusUsecase.execute({
            styleId,
            search: textParam(req, 'search'),
            activeOnly: boolParam(req, 'activeOnly'),
            limit: intParam(req, 'limit'),
            offset: intParam(req, 'offset'),
        });
        res.status(200).json(skus.map(toSkuWithStyleResponse));
    };

    // what the scanner does: GET /skus/lookup?code=<barcode or sku code>
    lookupSku = async (req: Request, res: Response) => {
        const detail = await this.lookupSkuUsecase.execute(textParam(req, 'code') as string);
        res.status(200).json(toSkuDetailResponse(detail));
    };

    getSku = async (req: Request, res: Response) => {
        const id = req.params.id as string;
        if (!isUuid(id)) throw new NotFoundError('Sku not found');
        res.status(200).json(toSkuDetailResponse(await this.getSkuUsecase.execute(id)));
    };

    updateSku = async (req: Request, res: Response) => {
        const id = req.params.id as string;
        if (!isUuid(id)) throw new NotFoundError('Sku not found');
        const input = req.body ?? {};
        const sku = await this.updateSkuUsecase.execute(
            { id, size: input.size, color: input.color, isActive: input.isActive },
            getAuth(req).user.getId(),
        );
        res.status(200).json(toSkuResponse(sku));
    };

    changePrice = async (req: Request, res: Response) => {
        const id = req.params.id as string;
        if (!isUuid(id)) throw new NotFoundError('Sku not found');
        const input = req.body ?? {};
        const sku = await this.changeSkuPriceUsecase.execute(id, input.price, getAuth(req).user.getId());
        res.status(200).json(toSkuResponse(sku));
    };

    priceHistory = async (req: Request, res: Response) => {
        const id = req.params.id as string;
        if (!isUuid(id)) throw new NotFoundError('Sku not found');
        const history = await this.getPriceHistoryUsecase.execute(id, intParam(req, 'limit'));
        res.status(200).json(history.map(toPriceChangeResponse));
    };

    addBarcode = async (req: Request, res: Response) => {
        const id = req.params.id as string;
        if (!isUuid(id)) throw new NotFoundError('Sku not found');
        const input = req.body ?? {};
        const barcode = await this.addBarcodeUsecase.execute(id, input.code, getAuth(req).user.getId());
        res.status(201).json(toBarcodeResponse(barcode));
    };

    removeBarcode = async (req: Request, res: Response) => {
        const id = req.params.id as string;
        if (!isUuid(id)) throw new NotFoundError('Barcode not found');
        await this.removeBarcodeUsecase.execute(id);
        res.status(204).send();
    };
}
