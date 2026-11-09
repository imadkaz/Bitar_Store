import { AuthContext } from '../../models/AuthContext';
import { parseCreateSupplier, parseUpdateSupplier } from '../../models/Supplier.model';
import { UserRole } from '../../models/User.model';
import { ISupplierRepository, SupplierView } from '../../repositories/interfaces/ISupplierRepository';
import { ForbiddenError } from '../../utils/exeptions/ForbiddenError';
import { NotFoundError } from '../../utils/exeptions/NotFoundError';
import { ValidationError } from '../../utils/exeptions/ValidationError';
import { isUuid } from '../../utils/uuid';
import { resolvePaging } from '../styles/paging';

// BL-06: managers create and edit suppliers; the warehouse work selects an existing one. Suppliers are not tied to a place.
export const canManageSuppliers = (auth: AuthContext): boolean => auth.user.getRole() === UserRole.ADMIN || auth.user.getRole() === UserRole.MANAGER;
const need = (auth: AuthContext) => { if (!canManageSuppliers(auth)) throw new ForbiddenError('Only an admin or a manager can manage suppliers'); };
const idOf = (raw: string) => { if (!isUuid(raw)) throw new NotFoundError('Supplier not found'); return raw; };

export class CreateSupplierUsecase {
    constructor(private readonly suppliers: ISupplierRepository) {}
    async execute(body: unknown, auth: AuthContext): Promise<SupplierView> { need(auth); return this.suppliers.create(parseCreateSupplier(body), auth.user.getId()); }
}

export class UpdateSupplierUsecase {
    constructor(private readonly suppliers: ISupplierRepository) {}
    async execute(rawId: string, body: unknown, auth: AuthContext): Promise<SupplierView> { need(auth); return this.suppliers.update(idOf(rawId), parseUpdateSupplier(body), auth.user.getId()); }
}

export class GetSupplierUsecase {
    constructor(private readonly suppliers: ISupplierRepository) {}
    async execute(rawId: string, auth: AuthContext): Promise<SupplierView> {
        need(auth);
        const supplier = await this.suppliers.findById(idOf(rawId));
        if (!supplier) throw new NotFoundError('Supplier not found');
        return supplier;
    }
}

export class ListSuppliersUsecase {
    constructor(private readonly suppliers: ISupplierRepository) {}
    async execute(input: { search?: unknown; active?: unknown; limit?: unknown; offset?: unknown }, auth: AuthContext): Promise<{ items: SupplierView[]; total: number }> {
        need(auth);
        let search: string | undefined;
        if (input.search !== undefined) {
            if (typeof input.search !== 'string' || input.search.trim().length < 1 || input.search.trim().length > 100) throw new ValidationError('search must be 1 to 100 characters');
            search = input.search.trim();
        }
        let active: boolean | undefined;
        if (input.active !== undefined) {
            if (input.active !== 'true' && input.active !== 'false') throw new ValidationError('active must be true or false');
            active = input.active === 'true';
        }
        const { limit, offset } = resolvePaging(input.limit, input.offset);
        return this.suppliers.list({ search, active, limit, offset });
    }
}
