export interface ReportScope {
    branchIds: string[];
    from: string;       // shop day, YYYY-MM-DD, inclusive
    to: string;         // inclusive
}

export interface SalesSummaryRow {
    branchId: string;
    day: string;
    salesCount: number;
    items: number;
    revenueCents: number;
    discountCents: number;
    cashCents: number;
    whishCents: number;
    inStoreCents: number;
    socialMediaCents: number;
    refundsCents: number;        // refunds of returns APPROVED that day at this branch (the branch that took the goods back), paid or still to pay
}

export interface TopSkuRow {
    skuId: string;
    skuCode: string;
    styleName: string;
    size: string;
    color: string;
    quantity: number;
    revenueCents: number;
    salesCount: number;
}

export interface ReplenishmentRow {
    branchId: string;
    skuId: string;
    skuCode: string;
    styleName: string;
    size: string;
    color: string;
    sellable: number;
    inTransit: number;
    minQuantity: number;
    targetQuantity: number | null;
}

export interface IReportRepository {
    salesSummary(scope: ReportScope): Promise<SalesSummaryRow[]>;
    topSkus(scope: ReportScope, limit: number): Promise<TopSkuRow[]>;
    // only (sku, branch) pairs whose sellable + in transit is BELOW the minimum
    replenishment(branchIds: string[]): Promise<ReplenishmentRow[]>;
    // sellable quantity per sku at one location (the warehouse)
    sellableAt(branchId: string, skuIds: string[]): Promise<Map<string, number>>;
}
