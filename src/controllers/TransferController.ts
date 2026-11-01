import { Request, Response } from 'express';
import { getAuth } from '../middlewares/Authenticate';
import { CancelTransferUsecase, CreateTransferUsecase, DispatchTransferUsecase, GetTransferUsecase, ListTransfersUsecase, ReceiveTransferUsecase, ResolveTransferUsecase, TransferActionResult } from '../usecases/transfer/TransferUsecases';
import { intParam, textParam } from './query';
import { toTransferResponse } from './responses';

export class TransferController {
    constructor(
        private readonly createTransfer: CreateTransferUsecase,
        private readonly dispatchTransfer: DispatchTransferUsecase,
        private readonly receiveTransfer: ReceiveTransferUsecase,
        private readonly resolveTransfer: ResolveTransferUsecase,
        private readonly cancelTransfer: CancelTransferUsecase,
        private readonly getTransfer: GetTransferUsecase,
        private readonly listTransfers: ListTransfersUsecase,
    ) {}

    private answer(res: Response, result: TransferActionResult, status = 200) {
        if (result.replayed) res.setHeader('Idempotent-Replay', 'true');     // the same request again: nothing new was done
        res.status(status).json(toTransferResponse(result.transfer));
    }

    // every step that moves stock or creates something needs the header  Idempotency-Key
    create = async (req: Request, res: Response) => this.answer(res, await this.createTransfer.execute(req.body, req.header('idempotency-key'), getAuth(req)), 201);
    dispatch = async (req: Request, res: Response) => this.answer(res, await this.dispatchTransfer.execute(req.params.id as string, req.body, req.header('idempotency-key'), getAuth(req)));
    receive = async (req: Request, res: Response) => this.answer(res, await this.receiveTransfer.execute(req.params.id as string, req.body, req.header('idempotency-key'), getAuth(req)));
    resolve = async (req: Request, res: Response) => this.answer(res, await this.resolveTransfer.execute(req.params.id as string, req.body, req.header('idempotency-key'), getAuth(req)));
    cancel = async (req: Request, res: Response) => {
        res.status(200).json(toTransferResponse(await this.cancelTransfer.execute(req.params.id as string, getAuth(req))));
    };

    get = async (req: Request, res: Response) => {
        res.status(200).json(toTransferResponse(await this.getTransfer.execute(req.params.id as string, getAuth(req))));
    };

    list = async (req: Request, res: Response) => {
        const { items, total } = await this.listTransfers.execute(
            { branchId: textParam(req, 'branchId'), status: textParam(req, 'status'), limit: intParam(req, 'limit'), offset: intParam(req, 'offset') },
            getAuth(req),
        );
        res.setHeader('X-Total-Count', String(total));
        res.status(200).json(items.map(toTransferResponse));
    };
}
