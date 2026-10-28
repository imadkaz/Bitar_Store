import { ConflictError } from './ConflictError';

export interface StockShortage {
    skuId: string;
    skuCode: string;
    requested: number;
    available: number;
}

// 409 with the list of items that are short, so the screen can say exactly which ones.
export class InsufficientStockError extends ConflictError {
    constructor(readonly shortages: StockShortage[]) {
        super('Not enough stock for one or more items');
        this.name = 'InsufficientStockError';
    }
}
