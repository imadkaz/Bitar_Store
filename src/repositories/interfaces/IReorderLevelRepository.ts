export interface ReorderLevelView {
    id: string;
    branchId: string;
    skuId: string;
    skuCode: string;
    styleName: string;
    size: string;
    color: string;
    minQuantity: number;
    targetQuantity: number | null;
    updatedAt: Date;
}

export interface ReorderLevelListFilter {
    branchId: string;
    search?: string;
    limit: number;
    offset: number;
}

// Every write keeps its audit event in the SAME transaction: no change without a record of who made it.
export interface IReorderLevelRepository {
    list(filter: ReorderLevelListFilter): Promise<ReorderLevelView[]>;
    findById(id: string): Promise<ReorderLevelView | null>;
    // key: `${skuId}|${branchId}`
    findForSkus(skuIds: string[]): Promise<Map<string, { min: number; target: number | null }>>;
    upsert(branchId: string, skuId: string, min: number, target: number | null, actorId: string): Promise<ReorderLevelView>;
    // applies to every ACTIVE sku of the style; returns how many skus were set
    upsertForStyle(branchId: string, styleId: string, min: number, target: number | null, actorId: string): Promise<number>;
    delete(id: string, actorId: string): Promise<void>;
}
