import { TransferStatus } from '../../models/Transfer.model';

export interface TransferPlace {
    id: string;
    code: string;
    name: string;
    kind: string;
}

export interface TransferLineView {
    skuId: string;
    skuCode: string;
    styleName: string;
    size: string;
    color: string;
    requestedQty: number;
    dispatchedQty: number;
    receivedQty: number;
    damagedQty: number;
    releasedQty: number;
    resolvedQty: number;
    outstandingQty: number;      // still on the road
    onHoldQty: number;           // good received, not yet sellable
}

export interface TransferView {
    id: string;
    reference: string;
    status: TransferStatus;
    source: TransferPlace;
    destination: TransferPlace;
    note: string | null;
    requestedBy: { id: string; name: string | null };
    requestedAt: Date;
    dispatchedBy: { id: string; name: string | null } | null;
    dispatchedAt: Date | null;
    lines: TransferLineView[];
}

export interface TransferListFilter {
    placeIds?: string[];         // only transfers that touch one of these places (a manager); undefined = every transfer (the admin)
    branchId?: string;           // only transfers that touch this place
    status?: TransferStatus;
    limit: number;
    offset: number;
}

export interface ITransferRepository {
    findById(id: string): Promise<TransferView | null>;
    list(filter: TransferListFilter): Promise<{ items: TransferView[]; total: number }>;
}
