import { Sale } from '../../models/Sale.model';

export type IdempotencyClaim =
    | { kind: 'claimed'; keyId: string }               // first time: go ahead
    | { kind: 'replay'; resourceId: string }           // the same request already finished: hand back its result
    | { kind: 'different_request' }                    // the key was used for ANOTHER request
    | { kind: 'in_progress' };                         // the key exists but never finished

export interface SkuForSale {
    skuId: string;
    skuCode: string;
    styleName: string;
    priceCents: number;
    currency: string;
    skuActive: boolean;
    styleActive: boolean;
}

// Everything a sale does inside ONE database transaction. If anything throws, everything is undone.
export interface SaleTransaction {
    claimIdempotencyKey(userId: string, operation: string, key: string, requestHash: string): Promise<IdempotencyClaim>;
    findSkusForSale(skuIds: string[]): Promise<SkuForSale[]>;
    // Locks these skus' sellable balances at the branch (always in sku order) and returns the quantities. A sku with no row has 0.
    lockSellableStock(branchId: string, skuIds: string[]): Promise<Map<string, number>>;
    // the open cash session of the branch (locked FOR SHARE so a closing waits for this sale); null when there is none and sessions are not required, a conflict when they are
    resolveCashSession(branchId: string): Promise<string | null>;
    insertSale(sale: Sale, idempotencyKeyId: string, actorId: string, cashSessionId?: string | null): Promise<void>;
    deductStock(branchId: string, saleId: string, items: { skuId: string; quantity: number }[], actorId: string, idempotencyKeyId: string): Promise<void>;
    completeIdempotencyKey(idempotencyKeyId: string, resourceType: string, resourceId: string): Promise<void>;
}

export interface ISalesUnitOfWork {
    run<T>(work: (tx: SaleTransaction) => Promise<T>): Promise<T>;
}
