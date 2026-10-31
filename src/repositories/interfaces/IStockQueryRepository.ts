export interface Quantities {
    sellable: number;
    nonSellable: number;
    inTransit: number;
}

export interface MovementView {
    id: string;
    occurredAt: Date;
    movementType: string;
    bucket: string;
    quantityDelta: number;
    balanceAfter: number;
    skuId: string;
    skuCode: string;
    actorId: string;
    actorName: string | null;
    saleId: string | null;
    reason: string | null;
}

export interface MovementFilter {
    branchId: string;
    skuId?: string;
    movementType?: string;
    from?: string;      // shop day, YYYY-MM-DD
    to?: string;
    limit: number;
    offset: number;
}

export interface IStockQueryRepository {
    // skuId -> branchId -> quantities (only where a balance row exists)
    quantities(skuIds: string[]): Promise<Map<string, Map<string, Quantities>>>;
    movements(filter: MovementFilter): Promise<MovementView[]>;
}
