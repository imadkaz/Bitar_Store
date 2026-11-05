import { UpdateInvoiceRequest } from '../../models/Invoice.model';

// Each of these runs in ONE transaction and returns the id of the invoice. The `authorize` function is called as soon as the
// thing the invoice is about has been read (inside the transaction), and throws when the user may not.
export interface IInvoiceWriter {
    createFromTransfer(transferId: string, actorId: string, note: string | null, authorize: (sourceBranchId: string, destinationBranchId: string) => void): Promise<string>;
    createFromSale(saleId: string, actorId: string, extra: { customerName: string | null; customerPhone: string | null; note: string | null }, authorize: (branchId: string) => void): Promise<string>;
    updateDraft(invoiceId: string, actorId: string, request: UpdateInvoiceRequest, authorize: (issuerBranchId: string, recipientBranchId: string | null) => void): Promise<string>;
    finalize(invoiceId: string, actorId: string, authorize: (issuerBranchId: string, recipientBranchId: string | null) => void): Promise<string>;
    void(invoiceId: string, actorId: string, reason: string, authorize: (issuerBranchId: string, recipientBranchId: string | null) => void): Promise<string>;
    deleteDraft(invoiceId: string, actorId: string, authorize: (issuerBranchId: string, recipientBranchId: string | null) => void): Promise<void>;
}
