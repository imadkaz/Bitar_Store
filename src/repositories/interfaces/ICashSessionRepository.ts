import { CorrectionField } from '../../models/CashSession.model';

type Person = { id: string; name: string | null };

export interface CashSessionView {
    id: string;
    reference: string;
    branch: { id: string; code: string; name: string };
    status: 'open' | 'closed';
    openedBy: Person;
    openedAt: Date;
    openingCash: string;
    expectedOpening: string | null;           // what the previous session left in the drawer (null: the first session of the branch)
    openingNote: string | null;
    responsible: Person;                      // who has the drawer now
    totals: { salesCount: number; salesTotal: string; cashPayments: string; whishPayments: string; cashIn: string; cashOut: string; expectedCash: string };
    byUser: { user: Person; salesCount: number; total: string; cash: string; whish: string }[];
    movements: { id: string; direction: 'in' | 'out'; amount: string; reason: string; by: Person; at: Date }[];
    handovers: { id: string; from: Person; to: Person; countedCash: string; expectedCash: string; difference: string; note: string | null; at: Date }[];
    corrections: { id: string; field: CorrectionField; before: string; after: string; reason: string; by: Person; at: Date }[];
    closing: { closedBy: Person; closedAt: Date; expectedCash: string; countedCash: string; difference: string; differenceNote: string | null; cashRemoved: string; cashLeft: string; lateClosed: boolean } | null;
    effective: { openingCash: string; countedCash: string; cashRemoved: string; cashLeft: string; expectedCash: string; difference: string } | null;     // the closing with the manager's corrections applied
    review: { status: 'none' | 'flagged' | 'reviewed'; by: Person | null; at: Date | null; note: string | null };
}

export interface CashSessionSummary {
    id: string;
    reference: string;
    branch: { id: string; code: string; name: string };
    status: 'open' | 'closed';
    openedBy: Person;
    openedAt: Date;
    responsible: Person;
    closedAt: Date | null;
    difference: string | null;
    lateClosed: boolean;
    reviewStatus: 'none' | 'flagged' | 'reviewed';
}

export interface CashSessionListFilter { branchIds: string[] | null; branchId?: string; status?: 'open' | 'closed'; review?: 'flagged' | 'reviewed' | 'none'; from?: string; to?: string; limit: number; offset: number }

export interface ICashSessionRepository {
    findById(id: string): Promise<CashSessionView | null>;
    findOpen(branchId: string): Promise<CashSessionView | null>;
    list(filter: CashSessionListFilter): Promise<{ items: CashSessionSummary[]; total: number }>;
    open(input: { branchId: string; openingCents: number; note: string | null }, actorId: string): Promise<string>;
    addMovement(input: { sessionId: string; direction: 'in' | 'out'; amountCents: number; reason: string; key: string; requestHash: string }, actorId: string, authorize: (branchId: string) => void): Promise<{ id: string; replayed: boolean }>;
    handover(input: { sessionId: string; countedCents: number; note: string | null; key: string; requestHash: string }, incomingId: string, authorize: (branchId: string) => void): Promise<{ id: string; replayed: boolean }>;
    close(input: { sessionId: string; countedCents: number; removedCents: number; differenceNote: string | null }, actorId: string, authorize: (branchId: string) => void): Promise<string>;
    correct(input: { sessionId: string; field: CorrectionField; valueCents: number; reason: string }, actorId: string, authorize: (branchId: string) => void): Promise<string>;
    review(input: { sessionId: string; note: string | null }, actorId: string, authorize: (branchId: string) => void): Promise<string>;
    branchOf(sessionId: string): Promise<string | null>;
}
