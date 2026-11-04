import { GoodsReceiptLineRequest, GoodsReceiptRequest } from '../../models/GoodsReceipt.model';
import { AuditInput } from '../audit';
import { IdempotencyClaim, SkuForSale } from './ISalesUnitOfWork';

export interface GoodsReceiptTransaction {
    claimIdempotencyKey(userId: string, operation: string, key: string, requestHash: string): Promise<IdempotencyClaim>;
    findSkus(skuIds: string[]): Promise<SkuForSale[]>;
    // has this supplier invoice already come in? (the same supplier and invoice number, whatever the letter case)
    findDuplicate(supplierName: string, supplierInvoiceNumber: string): Promise<{ id: string; reference: string } | null>;
    insertReceipt(request: GoodsReceiptRequest, totalCents: number, warehouseId: string, actorId: string, idempotencyKeyId: string): Promise<{ id: string; reference: string }>;
    // the warehouse stock grows by every line, and the ledger gets one row for each
    applyReceipt(receiptId: string, warehouseId: string, lines: GoodsReceiptLineRequest[], actorId: string, idempotencyKeyId: string): Promise<void>;
    audit(event: AuditInput): Promise<void>;
    completeIdempotencyKey(idempotencyKeyId: string, resourceType: string, resourceId: string): Promise<void>;
}

export interface IGoodsReceiptUnitOfWork {
    run<T>(work: (tx: GoodsReceiptTransaction) => Promise<T>): Promise<T>;
}
