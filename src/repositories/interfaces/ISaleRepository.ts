export interface SaleLineView {
    lineNo: number;
    skuId: string;
    skuCode: string;
    styleName: string;
    size: string;
    color: string;
    quantity: number;
    unitPriceCents: number;
    reduction: null | { type: 'percent'; percentHundredths: number; reason: string; approvedBy: string } | { type: 'override'; unitPriceCents: number; reason: string; approvedBy: string };
    lineTotalCents: number;
}

export interface SalePaymentView {
    method: 'cash' | 'whish';
    amountCents: number;
    tenderedCents: number | null;
    whishReference: string | null;
    receivedBy: string;
}

export interface SaleView {
    id: string;
    reference: string;
    branchId: string;
    soldBy: string;
    soldByName: string | null;
    status: string;
    channel: string;
    socialPlatform: string | null;
    currency: string;
    subtotalCents: number;
    discountCents: number;
    totalCents: number;
    soldAt: Date;
    businessDate: string;
    note: string | null;
    lines: SaleLineView[];
    payments: SalePaymentView[];
}

export interface SaleListFilter {
    branchId: string;
    businessDate: string;
    limit: number;
    offset: number;
}

export interface ISaleRepository {
    findById(id: string): Promise<SaleView | null>;
    list(filter: SaleListFilter): Promise<SaleView[]>;
}
