import { Request, Response } from 'express';
import { getAuth } from '../middlewares/Authenticate';
import { CreateStyleUsecase } from '../usecases/styles/CreateStyleUsecase';
import { GetStyleUsecase } from '../usecases/styles/GetStyleUsecase';
import { ListStylesUsecase } from '../usecases/styles/ListStylesUsecase';
import { UpdateStyleUsecase } from '../usecases/styles/UpdateStyleUsecase';
import { NotFoundError } from '../utils/exeptions/NotFoundError';
import { isUuid } from '../utils/uuid';
import { boolParam, intParam, textParam } from './query';
import { toSkuResponse, toStyleResponse } from './responses';

export class StyleController {
    constructor(
        private readonly createStyleUsecase: CreateStyleUsecase,
        private readonly listStylesUsecase: ListStylesUsecase,
        private readonly getStyleUsecase: GetStyleUsecase,
        private readonly updateStyleUsecase: UpdateStyleUsecase,
    ) {}

    createStyle = async (req: Request, res: Response) => {
        const input = req.body ?? {};   // fields are picked one by one: the client can't inject anything else
        const style = await this.createStyleUsecase.execute({ 
            code: input.code, 
            name: input.name, 
            category: input.category 
        },
            getAuth(req).user.getId(),
        );
        res.status(201).json(toStyleResponse(style));
    };

    listStyles = async (req: Request, res: Response) => {
        const styles = await this.listStylesUsecase.execute({
            search: textParam(req, 'search'),
            activeOnly: boolParam(req, 'activeOnly'),
            limit: intParam(req, 'limit'),
            offset: intParam(req, 'offset'),
        });
        res.status(200).json(styles.map(toStyleResponse));
    };

    getStyle = async (req: Request, res: Response) => {
        const id = req.params.id as string;
        if (!isUuid(id)) throw new NotFoundError('Style not found');
        const { style, skus } = await this.getStyleUsecase.execute(id);
        res.status(200).json({ ...toStyleResponse(style), skus: skus.map(toSkuResponse) });
    };

    updateStyle = async (req: Request, res: Response) => {
        const id = req.params.id as string;
        if (!isUuid(id)) throw new NotFoundError('Style not found');
        const input = req.body ?? {};
        const style = await this.updateStyleUsecase.execute({ 
            id, 
            name: input.name, 
            category: input.category, 
            isActive: input.isActive 
        },
            getAuth(req).user.getId(),
        );
        res.status(200).json(toStyleResponse(style));
    };
}
