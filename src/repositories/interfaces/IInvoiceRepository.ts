export type InvoiceKind = 'b2b' | 'b2c';
export type InvoiceStatus = 'draft' | 'final' | 'void';

export interface InvoiceLineView {
    lineNo: number;
    sku: { id: string; code: string };
    description: string;       // copied when the invoice was made: renaming the product later does not change it
    quantity: number;
    unitPrice: string;
    discount: string;
    lineTotal: string;
}

export interface InvoiceSummary {
    id: string;
    kind: InvoiceKind;
    status: InvoiceStatus;
    reference: string | null;           // given when it becomes final (a draft has none)
    issuer: { id: string; name: string };
    recipient: { branchId: string | null; name: string | null; phone: string | null };
    transfer: { id: string; reference: string } | null;
    sale: { id: string; reference: string } | null;
    currency: string;
    subtotal: string;
    discountTotal: string;
    total: string;
    note: string | null;
    issuedBy: { id: string; name: string | null };
    createdAt: Date;
    finalizedAt: Date | null;
    voided: { at: Date; by: { id: string; name: string | null }; reason: string } | null;
    lineCount: number;
}

export interface InvoiceView extends InvoiceSummary {
    lines: InvoiceLineView[];
    payments: { method: string; amount: string; reference: string | null }[];     // the payments of the sale, for a b2c invoice
}

export interface InvoiceListFilter {
    branchIds: string[] | null;     // the places the user reaches (an invoice is visible when it was issued by one or is addressed to one); null = every place
    kind?: InvoiceKind;
    status?: InvoiceStatus;
    branchId?: string;
    search?: string;                // the reference or the name of the customer or the branch
    from?: string;                  // YYYY-MM-DD, the day it was made
    to?: string;
    limit: number;
    offset: number;
}

export interface IInvoiceRepository {
    findById(id: string): Promise<InvoiceView | null>;
    list(filter: InvoiceListFilter): Promise<{ items: InvoiceSummary[]; total: number }>;
}
