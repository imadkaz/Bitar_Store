export interface StockAlertInput {
    operation: string;
    branchId: string;
    skuId: string;
    requestedQuantity: number;
    availableQuantity: number;
    actorId: string;
    idempotencyKey: string;
}

export interface IStockAlertRepository {
    // Written in its OWN transaction, after the sale was rolled back (a rolled back transaction cannot keep a record).
    // The same request retried does not create the same alert twice.
    recordInsufficient(alerts: StockAlertInput[]): Promise<void>;
}
