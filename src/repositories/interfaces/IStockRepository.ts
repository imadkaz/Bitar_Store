export interface StockLevel {
    skuId: string;
    sellable: number;
    nonSellable: number;
    inTransit: number;
}

export interface OpeningStockCommand {
    branchId: string;
    actorId: string;
    idempotencyKey: string;
    requestHash: string;
    lines: { skuId: string; quantity: number }[];
}

export interface OpeningStockResult {
    batchId: string;
    replayed: boolean;
}

export interface IStockRepository {
    getLevels(branchId: string, skuIds: string[]): Promise<Map<string, StockLevel>>;
    recordOpening(command: OpeningStockCommand): Promise<OpeningStockResult>;
}
