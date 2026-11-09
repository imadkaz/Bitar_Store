import { CreateReturnRequest, ReturnCondition } from '../../models/Return.model';

type Person = { id: string; name: string | null };

export interface ReturnLineView {
    id: string;
    saleLineId: string;
    sku: { id: string; code: string };
    description: string;
    quantity: number;
    condition: ReturnCondition;
    refundValue: string | null;        // fixed at approval: what was paid for these units
    releasedQty: number;               // released from hold to sale
    onHold: number;                    // approved and not yet released
}

export interface ReturnView {
    id: string;
    reference: string;
    status: 'in_custody' | 'approved' | 'rejected' | 'handed_back';
    custody: 'with_branch' | 'customer_keeps';
    sale: { id: string; reference: string; branch: { id: string; name: string }; soldAt: Date };
    receivingBranch: { id: string; code: string; name: string };
    reason: string;
    note: string | null;
    lateExceptionReason: string | null;
    receivedBy: Person;
    receivedAt: Date;
    decision: { by: Person; at: Date; reason: string | null } | null;
    handback: { to: string; by: Person; at: Date } | null;
    lines: ReturnLineView[];
    // an exchange: the new sale linked to this return; net = the new sale's total - the refund (positive: the customer pays more; negative: the business owes the customer)
    exchange: { saleId: string; saleReference: string; saleTotal: string; refundTotal: string; net: string; direction: 'customer_pays' | 'business_pays' | 'even'; linkedBy: Person; linkedAt: Date } | null;
    // the refund: fixed at approval; paid separately; never more than was paid
    refund: { total: string; paid: string; outstanding: string; status: 'pending' | 'paid'; payments: { id: string; method: 'cash' | 'whish'; amount: string; recipient: string; reference: string | null; by: Person; at: Date }[] } | null;
}

export interface ReturnSummary {
    id: string; reference: string; status: ReturnView['status']; saleReference: string; receivingBranch: { id: string; name: string };
    receivedAt: Date; units: number; refundTotal: string | null; refundOutstanding: string | null;
}

export interface ReturnListFilter { branchIds: string[] | null; branchId?: string; saleId?: string; status?: ReturnView['status']; from?: string; to?: string; limit: number; offset: number }

// what a sale line allows to be returned, for the screen that starts a return
export interface ReturnableSale {
    sale: { id: string; reference: string; status: string; branch: { id: string; name: string }; soldAt: Date; businessDate: string; total: string };
    returnPeriodDays: number;
    daysSinceSale: number;
    withinPeriod: boolean;
    lines: { saleLineId: string; skuId: string; skuCode: string; description: string; sold: number; returned: number; inCustody: number; returnable: number; lineTotal: string }[];
}

export interface IReturnRepository {
    findById(id: string): Promise<ReturnView | null>;
    list(filter: ReturnListFilter): Promise<{ items: ReturnSummary[]; total: number }>;
    returnable(saleKey: string, canSeeAll: boolean, branchIds: string[]): Promise<ReturnableSale | null>;
    create(request: CreateReturnRequest, actorId: string, key: string, requestHash: string, isManager: boolean, authorize: (receivingBranchId: string) => void): Promise<{ id: string; replayed: boolean }>;
    takeCustody(returnId: string, actorId: string, authorize: (branchId: string) => void): Promise<string>;
    approve(returnId: string, reason: string | null, actorId: string, key: string, requestHash: string, authorize: (branchId: string) => void): Promise<{ id: string; replayed: boolean }>;
    reject(returnId: string, reason: string, actorId: string, authorize: (branchId: string) => void): Promise<string>;
    handback(returnId: string, recipient: string, actorId: string, authorize: (branchId: string) => void): Promise<string>;
    release(returnId: string, lines: { returnLineId: string; quantity: number }[] | null, actorId: string, key: string, requestHash: string, authorize: (branchId: string) => void): Promise<{ id: string; replayed: boolean }>;
    payRefund(returnId: string, payment: { method: 'cash' | 'whish'; amountCents: number; recipient: string; reference: string | null }, actorId: string, key: string, requestHash: string, authorize: (branchId: string) => void): Promise<{ id: string; replayed: boolean }>;
    linkExchange(returnId: string, saleId: string, actorId: string, authorize: (branchId: string) => void): Promise<string>;
    branchesOf(returnId: string): Promise<{ receivingBranchId: string; saleBranchId: string } | null>;
}
