export interface GoodsReceiptLineView {
    sku: { id: string; code: string; styleName: string; size: string; color: string };
    quantity: number;
    unitCost: string;
    lineTotal: string;
}

export interface GoodsReceiptSummary {
    id: string;
    reference: string;
    warehouse: { id: string; code: string; name: string };
    supplier: { id: string; phone: string | null };      // the supplier now (its phone can change); supplierName below is the name it had on the day
    supplierName: string;
    supplierInvoiceNumber: string | null;
    invoiceDate: string;
    currency: string;
    note: string | null;
    totalCost: string;
    receivedBy: { id: string; name: string | null };
    createdAt: Date;
    lineCount: number;
    totalQuantity: number;
}

export interface GoodsReceiptView extends GoodsReceiptSummary {
    lines: GoodsReceiptLineView[];
}

export interface GoodsReceiptListFilter {
    supplier?: string;        // part of the supplier's name
    supplierId?: string;
    invoiceNumber?: string;   // part of the invoice number
    skuId?: string;
    from?: string;            // the date on the invoice, YYYY-MM-DD
    to?: string;
    limit: number;
    offset: number;
}

export interface IGoodsReceiptRepository {
    findById(id: string): Promise<GoodsReceiptView | null>;
    list(filter: GoodsReceiptListFilter): Promise<{ items: GoodsReceiptSummary[]; total: number }>;
}
