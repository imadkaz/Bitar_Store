import { AuditInput } from '../audit';
import { StockBucket, StockMove, Transfer } from '../../models/Transfer.model';
import { IdempotencyClaim, SkuForSale } from './ISalesUnitOfWork';

export interface PlaceInfo {
    id: string;
    code: string;
    name: string;
    isActive: boolean;
}

// Everything a transfer step does inside ONE database transaction. If anything throws, everything is undone.
export interface TransferTransaction {
    claimIdempotencyKey(userId: string, operation: string, key: string, requestHash: string): Promise<IdempotencyClaim>;
    findSkus(skuIds: string[]): Promise<SkuForSale[]>;
    findPlace(id: string): Promise<PlaceInfo | null>;
    insertTransfer(transfer: Transfer, actorId: string): Promise<void>;
    // locks the transfer row (two people acting on the same transfer wait for each other) and reads it with its lines
    lockTransfer(id: string): Promise<Transfer | null>;
    // locks these balances at the place (in sku order) and returns the quantities. A sku with no row has 0.
    lockStock(branchId: string, skuIds: string[], bucket: StockBucket): Promise<Map<string, number>>;
    // changes the balances AND writes one ledger row for each move
    applyMoves(transferId: string, moves: StockMove[], actorId: string, idempotencyKeyId: string): Promise<void>;
    saveTransfer(transfer: Transfer, actorId: string, dispatched?: { by: string; at: Date }): Promise<void>;
    audit(event: AuditInput): Promise<void>;
    completeIdempotencyKey(idempotencyKeyId: string, resourceType: string, resourceId: string): Promise<void>;
}

export interface ITransferUnitOfWork {
    run<T>(work: (tx: TransferTransaction) => Promise<T>): Promise<T>;
}
