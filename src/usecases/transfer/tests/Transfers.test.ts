import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { UserRole } from '../../../models/User.model';
import { FakeTransferAlertRepository, FakeTransferRepository, FakeTransferUnitOfWork, FakeTransferWorld } from '../../../test-helpers/transferFakes';
import { makeAuth } from '../../../test-helpers/salesFakes';
import { ConflictError } from '../../../utils/exeptions/ConflictError';
import { ForbiddenError } from '../../../utils/exeptions/ForbiddenError';
import { InsufficientStockError } from '../../../utils/exeptions/InsufficientStockError';
import { NotFoundError } from '../../../utils/exeptions/NotFoundError';
import { ValidationError } from '../../../utils/exeptions/ValidationError';
import { CancelTransferUsecase, CreateTransferUsecase, DispatchTransferUsecase, GetTransferUsecase, ListTransfersUsecase, ReceiveTransferUsecase, ResolveTransferUsecase } from '../TransferUsecases';

describe('transfers between the warehouse and the branches', () => {
    let world: FakeTransferWorld;
    let wh: ReturnType<FakeTransferWorld['addPlace']>;
    let hamra: ReturnType<FakeTransferWorld['addPlace']>;
    let tripoli: ReturnType<FakeTransferWorld['addPlace']>;
    let dress: ReturnType<FakeTransferWorld['addSku']>;
    let cap: ReturnType<FakeTransferWorld['addSku']>;
    let create: CreateTransferUsecase;
    let dispatch: DispatchTransferUsecase;
    let receive: ReceiveTransferUsecase;
    let resolve: ResolveTransferUsecase;
    let cancel: CancelTransferUsecase;
    let get: GetTransferUsecase;
    let list: ListTransfersUsecase;

    const admin = () => makeAuth(UserRole.ADMIN);
    const hamraManager = () => makeAuth(UserRole.MANAGER, [hamra.id]);
    const hamraStaff = () => makeAuth(UserRole.EMPLOYEE, [hamra.id]);
    const tripoliManager = () => makeAuth(UserRole.MANAGER, [tripoli.id]);
    const key = () => `tr-${randomUUID()}`;
    const draftBody = (patch: Record<string, unknown> = {}) => ({ sourceBranchId: wh.id, destinationBranchId: hamra.id, lines: [{ skuId: dress.skuId, quantity: 10 }, { skuId: cap.skuId, quantity: 4 }], ...patch });
    const makeDraft = async (body = draftBody()) => (await create.execute(body, key(), admin())).transfer;
    const makeSent = async (body = draftBody()) => { const t = await makeDraft(body); await dispatch.execute(t.id, {}, key(), admin()); return t; };
    const lineOf = (t: { lines: { skuId: string }[] }, skuId: string) => t.lines.find((l) => l.skuId === skuId)!;

    beforeEach(() => {
        world = new FakeTransferWorld();
        wh = world.addPlace('WAREHOUSE', 'warehouse');
        hamra = world.addPlace('HAMRA');
        tripoli = world.addPlace('TRIPOLI');
        dress = world.addSku();
        cap = world.addSku({ styleName: 'Basic Cap', size: 'One size' });
        world.set(wh.id, dress.skuId, 'sellable', 50);
        world.set(wh.id, cap.skuId, 'sellable', 20);
        const uow = new FakeTransferUnitOfWork(world);
        const repo = new FakeTransferRepository(world);
        create = new CreateTransferUsecase(uow, repo);
        dispatch = new DispatchTransferUsecase(uow, repo, new FakeTransferAlertRepository(world));
        receive = new ReceiveTransferUsecase(uow, repo);
        resolve = new ResolveTransferUsecase(uow, repo);
        cancel = new CancelTransferUsecase(uow, repo);
        get = new GetTransferUsecase(repo);
        list = new ListTransfersUsecase(repo);
    });

    describe('preparing a transfer (a draft)', () => {
        it('creates a draft: no stock moves, it is recorded, and who prepared it', async () => {
            const auth = admin();
            const { transfer, replayed } = await create.execute(draftBody({ note: ' weekly supply ' }), key(), auth);
            expect(replayed).toBe(false);
            expect(transfer).toMatchObject({ status: 'draft', reference: 'T-00000001', note: 'weekly supply', source: { code: 'WAREHOUSE' }, destination: { code: 'HAMRA' } });
            expect(transfer.lines.map((l) => [l.requestedQty, l.dispatchedQty])).toEqual([[10, 0], [4, 0]]);
            expect(world.qty(wh.id, dress.skuId, 'sellable')).toBe(50);
            expect(world.ledger).toHaveLength(0);
            expect(world.audits.map((a) => a.action)).toEqual(['transfer.create']);
        });

        it('the same request with the same key is not created twice', async () => {
            const auth = admin();
            const k = key();
            const first = await create.execute(draftBody(), k, auth);
            const second = await create.execute(draftBody(), k, auth);
            expect(second.replayed).toBe(true);
            expect(second.transfer.id).toBe(first.transfer.id);
            expect(world.transfers.size).toBe(1);
            await expect(create.execute(draftBody({ note: 'another' }), k, auth)).rejects.toThrow('different request');
        });

        it('needs the dispatch permission and a place of yours as the sender', async () => {
            await expect(create.execute(draftBody({ sourceBranchId: hamra.id, destinationBranchId: wh.id }), key(), hamraStaff())).rejects.toThrow('Missing permission: transfers.dispatch');
            await expect(create.execute(draftBody(), key(), hamraManager())).rejects.toBeInstanceOf(ForbiddenError);           // the warehouse is not Hamra's
            const back = await create.execute(draftBody({ sourceBranchId: hamra.id, destinationBranchId: wh.id }), key(), hamraManager());      // but Hamra may send back
            expect(back.transfer.source.code).toBe('HAMRA');
        });

        it('refuses unknown or closed places, unknown or inactive skus, and bad bodies', async () => {
            await expect(create.execute(draftBody({ destinationBranchId: randomUUID() }), key(), admin())).rejects.toBeInstanceOf(NotFoundError);
            const closed = world.addPlace('OLD', 'branch', false);
            await expect(create.execute(draftBody({ destinationBranchId: closed.id }), key(), admin())).rejects.toBeInstanceOf(ConflictError);
            await expect(create.execute(draftBody({ lines: [{ skuId: randomUUID(), quantity: 1 }] }), key(), admin())).rejects.toBeInstanceOf(NotFoundError);
            const retired = world.addSku({ skuActive: false });
            await expect(create.execute(draftBody({ lines: [{ skuId: retired.skuId, quantity: 1 }] }), key(), admin())).rejects.toBeInstanceOf(ConflictError);
            const bad: unknown[] = [undefined, null, 'x', [], {}, draftBody({ sourceBranchId: 'abc' }), draftBody({ destinationBranchId: wh.id }), draftBody({ lines: [] }), draftBody({ lines: 'x' }),
                draftBody({ lines: [{ skuId: dress.skuId, quantity: 0 }] }), draftBody({ lines: [{ skuId: dress.skuId, quantity: 1.5 }] }), draftBody({ lines: [{ skuId: 'abc', quantity: 1 }] }),
                draftBody({ lines: [{ skuId: dress.skuId, quantity: 1 }, { skuId: dress.skuId, quantity: 2 }] }), draftBody({ note: 5 })];
            for (const input of bad) await expect(create.execute(input, key(), admin()), JSON.stringify(input)).rejects.toBeInstanceOf(ValidationError);
            await expect(create.execute(draftBody(), 'short', admin())).rejects.toBeInstanceOf(ValidationError);
            expect(world.transfers.size).toBe(0);
        });
    });

    describe('dispatch: the pieces leave and are on the road', () => {
        it('takes the pieces off the sender, puts them on the road to the destination, and writes one ledger row for each change', async () => {
            const t = await makeDraft();
            const { transfer } = await dispatch.execute(t.id, undefined, key(), admin());
            expect(transfer.status).toBe('dispatched');
            expect(world.qty(wh.id, dress.skuId, 'sellable')).toBe(40);
            expect(world.qty(wh.id, cap.skuId, 'sellable')).toBe(16);
            expect(world.qty(hamra.id, dress.skuId, 'in_transit')).toBe(10);
            expect(world.qty(hamra.id, cap.skuId, 'in_transit')).toBe(4);
            expect(world.qty(hamra.id, dress.skuId, 'sellable')).toBe(0);                 // not on sale yet
            expect(world.ledger).toHaveLength(4);
            expect(world.ledger.every((m) => m.type === 'transfer_dispatch' && m.transferId === t.id)).toBe(true);
            expect(transfer.dispatchedBy?.id).toBeTruthy();
            expect(world.audits.map((a) => a.action)).toEqual(['transfer.create', 'transfer.dispatch']);
        });

        it('can send less than asked on a line, or nothing on a line', async () => {
            const t = await makeDraft();
            const { transfer } = await dispatch.execute(t.id, { lines: [{ skuId: dress.skuId, quantity: 6 }, { skuId: cap.skuId, quantity: 0 }] }, key(), admin());
            expect(lineOf(transfer, dress.skuId)).toMatchObject({ requestedQty: 10, dispatchedQty: 6 });
            expect(lineOf(transfer, cap.skuId)).toMatchObject({ requestedQty: 4, dispatchedQty: 0 });
            expect(world.qty(hamra.id, dress.skuId, 'in_transit')).toBe(6);
            expect(world.qty(wh.id, cap.skuId, 'sellable')).toBe(20);
        });

        it('not enough at the sender: 409 listing the items, NOTHING moves, the key is free again, and the shortage is recorded for the managers', async () => {
            world.set(wh.id, cap.skuId, 'sellable', 3);                                    // 4 wanted
            const t = await makeDraft();
            const k = key();
            const me = admin();
            const error = await dispatch.execute(t.id, {}, k, me).catch((e) => e);
            expect(error).toBeInstanceOf(InsufficientStockError);
            expect(error.details ?? error.shortages).toEqual([{ skuId: cap.skuId, skuCode: cap.skuCode, requested: 4, available: 3 }]);
            expect(world.qty(wh.id, dress.skuId, 'sellable')).toBe(50);                    // the dress line was fine, but it was undone too
            expect(world.qty(hamra.id, dress.skuId, 'in_transit')).toBe(0);
            expect(world.ledger).toHaveLength(0);
            expect((await get.execute(t.id, admin())).status).toBe('draft');
            await dispatch.execute(t.id, {}, k, me).catch(() => undefined);                // the same request again: still one alert
            expect(world.alerts).toHaveLength(1);
            expect(world.alerts[0]).toMatchObject({ operation: 'transfer.dispatch', branchId: wh.id, skuId: cap.skuId, requestedQuantity: 4, availableQuantity: 3 });
            world.set(wh.id, cap.skuId, 'sellable', 10);
            expect((await dispatch.execute(t.id, {}, k, me)).transfer.status).toBe('dispatched');       // stock arrived: the same key works now
        });

        it('happens once: the same request again gives the same transfer back, another dispatch is refused', async () => {
            const t = await makeDraft();
            const k = key();
            const me = admin();
            await dispatch.execute(t.id, {}, k, me);
            const again = await dispatch.execute(t.id, {}, k, me);
            expect(again.replayed).toBe(true);
            expect(world.qty(wh.id, dress.skuId, 'sellable')).toBe(40);                     // sent once
            expect(world.ledger).toHaveLength(4);
            await expect(dispatch.execute(t.id, {}, key(), admin())).rejects.toThrow('Only a draft can be dispatched');
            expect(world.qty(wh.id, dress.skuId, 'sellable')).toBe(40);
        });

        it('only the sending place may dispatch; a place that does not touch it does not even see it', async () => {
            const t = await makeDraft();
            await expect(dispatch.execute(t.id, {}, key(), hamraManager())).rejects.toThrow('Only the sending place can dispatch');       // the receiver
            await expect(dispatch.execute(t.id, {}, key(), tripoliManager())).rejects.toBeInstanceOf(NotFoundError);                      // a stranger
            await expect(dispatch.execute(t.id, {}, key(), hamraStaff())).rejects.toThrow('Missing permission');
            await expect(dispatch.execute(randomUUID(), {}, key(), admin())).rejects.toBeInstanceOf(NotFoundError);
            await expect(dispatch.execute('abc', {}, key(), admin())).rejects.toBeInstanceOf(NotFoundError);
            expect(world.ledger).toHaveLength(0);
        });

        it('refuses a closed destination and bad quantities', async () => {
            const t = await makeDraft();
            world.places.get(hamra.id)!.isActive = false;
            await expect(dispatch.execute(t.id, {}, key(), admin())).rejects.toBeInstanceOf(ConflictError);
            world.places.get(hamra.id)!.isActive = true;
            for (const lines of [[{ skuId: dress.skuId, quantity: 11 }], [{ skuId: dress.skuId, quantity: -1 }], [{ skuId: randomUUID(), quantity: 1 }], [{ skuId: dress.skuId, quantity: 0 }, { skuId: cap.skuId, quantity: 0 }]]) {
                await expect(dispatch.execute(t.id, { lines }, key(), admin()), JSON.stringify(lines)).rejects.toBeInstanceOf(ValidationError);
            }
            expect(world.ledger).toHaveLength(0);
        });
    });

    describe('receiving: good pieces on sale, damaged ones on hold', () => {
        it('the destination says what arrived; the road empties and the shelf fills', async () => {
            const t = await makeSent();
            const { transfer } = await receive.execute(t.id, { lines: [{ skuId: dress.skuId, accepted: 8, damaged: 1 }] }, key(), hamraStaff());   // an employee may receive
            expect(transfer.status).toBe('partially_received');
            expect(world.qty(hamra.id, dress.skuId, 'in_transit')).toBe(1);
            expect(world.qty(hamra.id, dress.skuId, 'sellable')).toBe(8);
            expect(world.qty(hamra.id, dress.skuId, 'non_sellable')).toBe(1);
            expect(lineOf(transfer, dress.skuId)).toMatchObject({ receivedQty: 9, outstandingQty: 1 });
            expect(world.ledger.filter((m) => m.type === 'transfer_receipt')).toHaveLength(3);
        });

        it('in several rounds, until everything is in: received', async () => {
            const t = await makeSent();
            await receive.execute(t.id, { lines: [{ skuId: dress.skuId, accepted: 10 }] }, key(), hamraManager());
            expect((await get.execute(t.id, admin())).status).toBe('partially_received');
            const done = await receive.execute(t.id, { lines: [{ skuId: cap.skuId, accepted: 4 }] }, key(), hamraManager());
            expect(done.transfer.status).toBe('received');
            expect(done.transfer.lines.every((l) => l.outstandingQty === 0)).toBe(true);
            expect(world.qty(hamra.id, dress.skuId, 'in_transit') + world.qty(hamra.id, cap.skuId, 'in_transit')).toBe(0);
        });

        it('the same request again is not counted twice; more than is on the road is refused', async () => {
            const t = await makeSent();
            const k = key();
            const me = hamraManager();
            const body = { lines: [{ skuId: dress.skuId, accepted: 6 }] };
            await receive.execute(t.id, body, k, me);
            expect((await receive.execute(t.id, body, k, me)).replayed).toBe(true);
            expect(world.qty(hamra.id, dress.skuId, 'sellable')).toBe(6);
            await expect(receive.execute(t.id, { lines: [{ skuId: dress.skuId, accepted: 5 }] }, key(), hamraManager())).rejects.toThrow('Only 4 are still on the way');
            expect(world.qty(hamra.id, dress.skuId, 'sellable')).toBe(6);
        });

        it('only the receiving place; not a draft; not someone who cannot see it', async () => {
            const draft = await makeDraft();
            await expect(receive.execute(draft.id, { lines: [{ skuId: dress.skuId, accepted: 1 }] }, key(), hamraManager())).rejects.toThrow('on the road');
            const t = await makeSent();
            const body = { lines: [{ skuId: dress.skuId, accepted: 1 }] };
            await expect(receive.execute(t.id, body, key(), makeAuth(UserRole.MANAGER, [wh.id]))).rejects.toThrow('Only the receiving place can receive');
            await expect(receive.execute(t.id, body, key(), tripoliManager())).rejects.toBeInstanceOf(NotFoundError);
            await expect(receive.execute(t.id, body, key(), hamraStaff())).resolves.toBeTruthy();       // an employee of the destination may receive
        });

        it('every bad body is a 400', async () => {
            const t = await makeSent();
            const bad: unknown[] = [undefined, {}, { lines: [] }, { lines: 'x' }, { lines: [{ skuId: dress.skuId, accepted: 0 }] }, { lines: [{ skuId: dress.skuId, accepted: -1 }] },
                { lines: [{ skuId: dress.skuId, accepted: 1.5 }] }, { lines: [{ skuId: randomUUID(), accepted: 1 }] }, { lines: [{ skuId: dress.skuId, accepted: 1 }, { skuId: dress.skuId, accepted: 1 }] }, { lines: [null] }];
            for (const body of bad) await expect(receive.execute(t.id, body, key(), hamraManager()), JSON.stringify(body)).rejects.toBeInstanceOf(ValidationError);
            expect(world.qty(hamra.id, dress.skuId, 'sellable')).toBe(0);
        });
    });

    describe('what never arrived', () => {
        it('a manager confirms the loss with a reason: it leaves the road and the transfer is closed', async () => {
            const t = await makeSent(draftBody({ lines: [{ skuId: dress.skuId, quantity: 10 }] }));
            await receive.execute(t.id, { lines: [{ skuId: dress.skuId, accepted: 9 }] }, key(), hamraManager());
            const { transfer } = await resolve.execute(t.id, { reason: 'One dress lost by the courier' }, key(), hamraManager());
            expect(transfer.status).toBe('closed');
            expect(lineOf(transfer, dress.skuId)).toMatchObject({ receivedQty: 9, resolvedQty: 1, outstandingQty: 0 });
            expect(world.qty(hamra.id, dress.skuId, 'in_transit')).toBe(0);
            expect(world.ledger.at(-1)).toMatchObject({ type: 'transfer_resolution', delta: -1, bucket: 'in_transit', reason: 'One dress lost by the courier' });
            expect(world.audits.at(-1)).toMatchObject({ action: 'transfer.resolve', details: expect.objectContaining({ lost: 1, reason: 'One dress lost by the courier', status: 'closed' }) });
        });

        it('needs a reason, the dispatch permission (an employee cannot), and units still on the road', async () => {
            const t = await makeSent();
            await expect(resolve.execute(t.id, { reason: 'x' }, key(), hamraManager())).rejects.toBeInstanceOf(ValidationError);
            await expect(resolve.execute(t.id, {}, key(), hamraManager())).rejects.toBeInstanceOf(ValidationError);
            await expect(resolve.execute(t.id, { reason: 'lost box' }, key(), hamraStaff())).rejects.toThrow('Missing permission');
            await expect(resolve.execute(t.id, { reason: 'lost box' }, key(), tripoliManager())).rejects.toBeInstanceOf(NotFoundError);
            await receive.execute(t.id, { lines: [{ skuId: dress.skuId, accepted: 10 }, { skuId: cap.skuId, accepted: 4 }] }, key(), hamraManager());
            await expect(resolve.execute(t.id, { reason: 'nothing is lost' }, key(), hamraManager())).rejects.toBeInstanceOf(ConflictError);
        });

        it('the same request again is not applied twice', async () => {
            const t = await makeSent();
            const k = key();
            const me = hamraManager();
            await resolve.execute(t.id, { reason: 'box never came', lines: [{ skuId: cap.skuId, quantity: 4 }] }, k, me);
            expect((await resolve.execute(t.id, { reason: 'box never came', lines: [{ skuId: cap.skuId, quantity: 4 }] }, k, me)).replayed).toBe(true);
            expect(world.qty(hamra.id, cap.skuId, 'in_transit')).toBe(0);
            expect(world.ledger.filter((m) => m.type === 'transfer_resolution')).toHaveLength(1);
        });
    });

    describe('cancel', () => {
        it('a draft can be cancelled; asking again changes nothing; after dispatch it cannot', async () => {
            const t = await makeDraft();
            expect((await cancel.execute(t.id, admin())).status).toBe('cancelled');
            expect((await cancel.execute(t.id, admin())).status).toBe('cancelled');
            expect(world.audits.filter((a) => a.action === 'transfer.cancel')).toHaveLength(1);
            await expect(dispatch.execute(t.id, {}, key(), admin())).rejects.toBeInstanceOf(ConflictError);
            const sent = await makeSent();
            await expect(cancel.execute(sent.id, admin())).rejects.toThrow('Only a draft can be cancelled');
        });

        it('only the sender, with the permission', async () => {
            const t = await makeDraft();
            await expect(cancel.execute(t.id, hamraManager())).rejects.toBeInstanceOf(ForbiddenError);
            await expect(cancel.execute(t.id, hamraStaff())).rejects.toThrow('Missing permission');
            await expect(cancel.execute(t.id, tripoliManager())).rejects.toBeInstanceOf(NotFoundError);
        });
    });

    describe('reading', () => {
        beforeEach(async () => {
            await makeDraft();                                                                                       // T-1 WAREHOUSE -> HAMRA
            await makeDraft(draftBody({ destinationBranchId: tripoli.id }));                                         // T-2 WAREHOUSE -> TRIPOLI
            await makeSent(draftBody({ lines: [{ skuId: dress.skuId, quantity: 1 }] }));                             // T-3 sent
        });

        it('the admin sees every transfer; a manager only the ones that touch their places; a stranger gets "not found"', async () => {
            expect((await list.execute({}, admin())).total).toBe(3);
            const mine = await list.execute({}, hamraManager());
            expect(mine.items.map((t) => t.destination.code)).toEqual(['HAMRA', 'HAMRA']);
            const t2 = [...world.transfers.values()].find((t) => t.destinationBranchId === tripoli.id)!;
            await expect(get.execute(t2.id, hamraManager())).rejects.toBeInstanceOf(NotFoundError);
            expect((await get.execute(t2.id, tripoliManager())).destination.code).toBe('TRIPOLI');
            await expect(get.execute('abc', admin())).rejects.toBeInstanceOf(NotFoundError);
        });

        it('filters by place and status, pages with a total, newest first', async () => {
            expect((await list.execute({ branchId: tripoli.id }, admin())).total).toBe(1);
            expect((await list.execute({ status: 'draft' }, admin())).total).toBe(2);
            expect((await list.execute({ status: 'dispatched' }, admin())).total).toBe(1);
            const page = await list.execute({ limit: 2, offset: 0 }, admin());
            expect([page.items.length, page.total, page.items[0].reference]).toEqual([2, 3, 'T-00000003']);
            await expect(list.execute({ branchId: tripoli.id }, hamraManager())).rejects.toBeInstanceOf(ForbiddenError);
            for (const bad of [{ branchId: 'abc' }, { status: 'lost' }, { limit: 0 }, { offset: -1 }]) await expect(list.execute(bad, admin()), JSON.stringify(bad)).rejects.toBeInstanceOf(ValidationError);
        });
    });

    describe('the books always balance', () => {
        it('after a whole life, what left the warehouse = on sale + on hold + lost, and nothing is negative', async () => {
            const t = await makeSent(draftBody({ lines: [{ skuId: dress.skuId, quantity: 10 }] }));
            await receive.execute(t.id, { lines: [{ skuId: dress.skuId, accepted: 5, damaged: 1 }] }, key(), hamraManager());
            await receive.execute(t.id, { lines: [{ skuId: dress.skuId, accepted: 2 }] }, key(), hamraManager());
            await resolve.execute(t.id, { reason: 'two pieces lost' }, key(), hamraManager());
            const left = 50 - world.qty(wh.id, dress.skuId, 'sellable');
            const arrivedOnSale = world.qty(hamra.id, dress.skuId, 'sellable');
            const onHold = world.qty(hamra.id, dress.skuId, 'non_sellable');
            const lost = -world.ledger.filter((m) => m.type === 'transfer_resolution').reduce((s, m) => s + m.delta, 0);
            expect([left, arrivedOnSale, onHold, lost]).toEqual([10, 7, 1, 2]);
            expect(arrivedOnSale + onHold + lost).toBe(left);
            expect(world.qty(hamra.id, dress.skuId, 'in_transit')).toBe(0);
            expect(world.ledger.every((m) => m.balanceAfter >= 0)).toBe(true);
            expect((await get.execute(t.id, admin())).status).toBe('closed');
        });
    });
});
