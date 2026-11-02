export interface AdjustmentView {
    id: string;
    reference: string;
    branch: { id: string; code: string; name: string };
    sku: { id: string; code: string; styleName: string; size: string; color: string };
    bucket: string;
    quantityDelta: number;
    reason: string;
    note: string;
    by: { id: string; name: string | null };
    createdAt: Date;
    balanceAfter: number | null;      // the balance of that bucket right after the adjustment
}

export interface AdjustmentListFilter {
    branchIds: string[];
    skuId?: string;
    reason?: string;
    from?: string;      // shop day, YYYY-MM-DD
    to?: string;
    limit: number;
    offset: number;
}

export interface IAdjustmentRepository {
    findById(id: string): Promise<AdjustmentView | null>;
    list(filter: AdjustmentListFilter): Promise<{ items: AdjustmentView[]; total: number }>;
}
