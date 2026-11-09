import { UpdateInvoiceRequest } from '../../models/Invoice.model';

// Each of these runs in ONE transaction and returns the id of the invoice. The `authorize` function is called as soon as the
// thing the invoice is about has been read (inside the transaction), and throws when the user may not.
export interface IInvoiceWriter {
    // invoiceKind: which of the transfer's invoices (null: the first one it needs). authorize gets the two places of the transfer and the one that ISSUES the invoice.
    createFromTransfer(transferId: string, actorId: string, note: string | null, authorize: (sourceBranchId: string, destinationBranchId: string, issuerBranchId: string) => void, invoiceKind?: 'b2b' | 'b2b_return' | null): Promise<string>;
    // after a dispatch: every draft invoice the transfer needs (from the warehouse: the supply invoice; to the warehouse: the return invoice; branch to branch: both)
    raiseDraftsForTransfer(transferId: string, actorId: string): Promise<string[]>;
    createFromSale(saleId: string, actorId: string, extra: { customerName: string | null; customerPhone: string | null; note: string | null }, authorize: (branchId: string) => void): Promise<string>;
    updateDraft(invoiceId: string, actorId: string, request: UpdateInvoiceRequest, authorize: (issuerBranchId: string, recipientBranchId: string | null) => void): Promise<string>;
    finalize(invoiceId: string, actorId: string, authorize: (issuerBranchId: string, recipientBranchId: string | null) => void): Promise<string>;
    void(invoiceId: string, actorId: string, reason: string, authorize: (issuerBranchId: string, recipientBranchId: string | null) => void): Promise<string>;
    deleteDraft(invoiceId: string, actorId: string, authorize: (issuerBranchId: string, recipientBranchId: string | null) => void): Promise<void>;
}
