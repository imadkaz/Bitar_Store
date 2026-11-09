import { CreateSupplierRequest, UpdateSupplierRequest } from '../../models/Supplier.model';

export interface SupplierView {
    id: string;
    name: string;
    phone: string | null;        // null only for a supplier that came from old receipts: a manager fills it in
    note: string | null;
    isActive: boolean;
    receiptCount: number;
    createdAt: Date;
    updatedAt: Date;
}

export interface SupplierListFilter { search?: string; active?: boolean; limit: number; offset: number }

export interface ISupplierRepository {
    findById(id: string): Promise<SupplierView | null>;
    list(filter: SupplierListFilter): Promise<{ items: SupplierView[]; total: number }>;
    create(request: CreateSupplierRequest, actorId: string): Promise<SupplierView>;
    update(id: string, request: UpdateSupplierRequest, actorId: string): Promise<SupplierView>;
}
