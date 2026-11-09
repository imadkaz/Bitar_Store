export const STOCK_BUCKET_ORDER = ['sellable', 'non_sellable', 'in_transit'] as const;
export type StockBucket = (typeof STOCK_BUCKET_ORDER)[number];

export function compareStockBuckets(a: StockBucket, b: StockBucket): number {
    return STOCK_BUCKET_ORDER.indexOf(a) - STOCK_BUCKET_ORDER.indexOf(b);
}
