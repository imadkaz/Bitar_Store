import { AuthContext } from '../../models/AuthContext';
import { UserRole } from '../../models/User.model';
import { parseCreateInvoice, parseInvoiceUpdate, parseVoidReason } from '../../models/Invoice.model';
import { IInvoiceRepository, InvoiceKind, InvoiceStatus, InvoiceSummary, InvoiceView } from '../../repositories/interfaces/IInvoiceRepository';
import { IInvoiceWriter } from '../../repositories/interfaces/IInvoiceWriter';
import { renderInvoicePdf } from '../../services/InvoicePdfService';
import { ForbiddenError } from '../../utils/exeptions/ForbiddenError';
import { NotFoundError } from '../../utils/exeptions/NotFoundError';
import { ValidationError } from '../../utils/exeptions/ValidationError';
import { isUuid } from '../../utils/uuid';
import { resolvePaging } from '../styles/paging';
import { parseOptionalUuid, parseShopDay, parseSlug } from '../insight/scope';

const idOf = (raw: string): string => {
    if (!isUuid(raw)) throw new NotFoundError('Invoice not found');
    return raw;
};

// Who may do what with the invoices
//   see one (read, list, PDF): anyone who reaches the place that issued it or the place it is addressed to (the admin: all)
//   make a supply invoice from a transfer, edit its prices, finalize it, void it, delete a draft: transfers.dispatch (admin, manager) at the SENDING place
//   make the invoice of a sale: sales.create at the branch where it was sold
const issuerOnly = (auth: AuthContext) => (issuerBranchId: string, recipientBranchId: string | null): void => {
    if (auth.canAccessBranch(issuerBranchId)) return;
    if (recipientBranchId && auth.canAccessBranch(recipientBranchId)) throw new ForbiddenError('Only the place that issued the invoice can do this');
    throw new NotFoundError('Invoice not found');
};
const needDispatch = (auth: AuthContext) => {
    if (!auth.can('transfers.dispatch')) throw new ForbiddenError('Missing permission: transfers.dispatch');
};

export class CreateInvoiceUsecase {
    constructor(private readonly writer: IInvoiceWriter, private readonly invoices: IInvoiceRepository) {}

    async execute(body: unknown, auth: AuthContext): Promise<InvoiceView> {
        const request = parseCreateInvoice(body);
        const actorId = auth.user.getId();
        let id: string;
        if (request.kind === 'b2b') {
            needDispatch(auth);
            id = await this.writer.createFromTransfer(request.transferId, actorId, request.note, (source, destination) => {
                if (auth.canAccessBranch(source)) return;
                if (auth.canAccessBranch(destination)) throw new ForbiddenError('Only the sending place can make the supply invoice');
                throw new NotFoundError('Transfer not found');
            });
        } else {
            if (!auth.can('sales.create')) throw new ForbiddenError('Missing permission: sales.create');
            id = await this.writer.createFromSale(request.saleId, actorId, { customerName: request.customerName, customerPhone: request.customerPhone, note: request.note }, (branchId) => {
                if (!auth.canAccessBranch(branchId)) throw new NotFoundError('Sale not found');
            });
        }
        return (await this.invoices.findById(id))!;
    }
}

export class GetInvoiceUsecase {
    constructor(private readonly invoices: IInvoiceRepository) {}

    async execute(rawId: string, auth: AuthContext): Promise<InvoiceView> {
        const invoice = await this.invoices.findById(idOf(rawId));
        if (!invoice || !(auth.canAccessBranch(invoice.issuer.id) || (invoice.recipient.branchId !== null && auth.canAccessBranch(invoice.recipient.branchId)))) throw new NotFoundError('Invoice not found');
        return invoice;
    }
}

export class GetInvoicePdfUsecase {
    constructor(private readonly get: GetInvoiceUsecase) {}

    async execute(rawId: string, auth: AuthContext): Promise<{ pdf: Buffer; filename: string }> {
        const invoice = await this.get.execute(rawId, auth);
        return { pdf: await renderInvoicePdf(invoice), filename: `${invoice.reference ?? `draft-${invoice.id.slice(0, 8)}`}.pdf` };
    }
}

export class ListInvoicesUsecase {
    constructor(private readonly invoices: IInvoiceRepository) {}

    async execute(input: { kind?: unknown; status?: unknown; branchId?: unknown; search?: unknown; from?: unknown; to?: unknown; limit?: unknown; offset?: unknown }, auth: AuthContext): Promise<{ items: InvoiceSummary[]; total: number }> {
        if (input.kind !== undefined && input.kind !== 'b2b' && input.kind !== 'b2c') throw new ValidationError('kind must be b2b or b2c');
        const kind = input.kind as InvoiceKind | undefined;
        const status = parseSlug(input.status, 'status') as InvoiceStatus | undefined;
        if (status !== undefined && !['draft', 'final', 'void'].includes(status)) throw new ValidationError('status must be draft, final or void');
        const branchId = parseOptionalUuid(input.branchId, 'branchId');
        let search: string | undefined;
        if (input.search !== undefined) {
            if (typeof input.search !== 'string' || input.search.trim().length < 1 || input.search.trim().length > 100) throw new ValidationError('search must be 1 to 100 characters');
            search = input.search.trim();
        }
        const from = parseShopDay(input.from, 'from');
        const to = parseShopDay(input.to, 'to');
        if (from && to && from > to) throw new ValidationError('from must not be after to');
        const { limit, offset } = resolvePaging(input.limit, input.offset);
        if (branchId !== undefined && !auth.canAccessBranch(branchId)) throw new ForbiddenError('You cannot see the invoices of this place');
        const isAdmin = auth.user.getRole() === UserRole.ADMIN;                                // the admin sees the invoices of every place
        return this.invoices.list({ branchIds: isAdmin ? null : auth.getBranchIds(), kind, status, branchId, search, from, to, limit, offset });
    }
}

export class UpdateInvoiceUsecase {
    constructor(private readonly writer: IInvoiceWriter, private readonly invoices: IInvoiceRepository) {}

    async execute(rawId: string, body: unknown, auth: AuthContext): Promise<InvoiceView> {
        needDispatch(auth);
        const request = parseInvoiceUpdate(body);
        const id = await this.writer.updateDraft(idOf(rawId), auth.user.getId(), request, issuerOnly(auth));
        return (await this.invoices.findById(id))!;
    }
}

export class FinalizeInvoiceUsecase {
    constructor(private readonly writer: IInvoiceWriter, private readonly invoices: IInvoiceRepository) {}

    async execute(rawId: string, auth: AuthContext): Promise<InvoiceView> {
        needDispatch(auth);
        const id = await this.writer.finalize(idOf(rawId), auth.user.getId(), issuerOnly(auth));
        return (await this.invoices.findById(id))!;
    }
}

export class VoidInvoiceUsecase {
    constructor(private readonly writer: IInvoiceWriter, private readonly invoices: IInvoiceRepository) {}

    async execute(rawId: string, body: unknown, auth: AuthContext): Promise<InvoiceView> {
        needDispatch(auth);
        const reason = parseVoidReason(body);
        const id = await this.writer.void(idOf(rawId), auth.user.getId(), reason, issuerOnly(auth));
        return (await this.invoices.findById(id))!;
    }
}

export class DeleteInvoiceUsecase {
    constructor(private readonly writer: IInvoiceWriter) {}

    async execute(rawId: string, auth: AuthContext): Promise<void> {
        needDispatch(auth);
        await this.writer.deleteDraft(idOf(rawId), auth.user.getId(), issuerOnly(auth));
    }
}
