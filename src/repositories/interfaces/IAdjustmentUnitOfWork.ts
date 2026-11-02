import { AdjustableBucket, AdjustmentRequest, PlannedMove } from '../../models/Adjustment.model';
import { AuditInput } from '../audit';
import { IdempotencyClaim, SkuForSale } from './ISalesUnitOfWork';

export interface AdjustmentTransaction {
    claimIdempotencyKey(userId: string, operation: string, key: string, requestHash: string): Promise<IdempotencyClaim>;
    findSkus(skuIds: string[]): Promise<SkuForSale[]>;
    placeExists(branchId: string): Promise<{ code: string } | null>;
    // locks the balances of this sku at this place and returns the quantities (0 where there is no row yet)
    lockBalances(branchId: string, skuId: string, buckets: AdjustableBucket[]): Promise<Map<AdjustableBucket, number>>;
    insertAdjustment(request: AdjustmentRequest, actorId: string, idempotencyKeyId: string): Promise<{ id: string; reference: string }>;
    // changes the balances AND writes one ledger row for each move
    applyMoves(adjustmentId: string, request: AdjustmentRequest, moves: PlannedMove[], actorId: string, idempotencyKeyId: string): Promise<void>;
    audit(event: AuditInput): Promise<void>;
    completeIdempotencyKey(idempotencyKeyId: string, resourceType: string, resourceId: string): Promise<void>;
}

export interface IAdjustmentUnitOfWork {
    run<T>(work: (tx: AdjustmentTransaction) => Promise<T>): Promise<T>;
}
