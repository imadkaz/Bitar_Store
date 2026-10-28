import { beforeEach, describe, expect, it } from 'vitest';
import { Branch } from '../../../models/Branch.model';
import { UserRole } from '../../../models/User.model';
import { FakeBranchRepository } from '../../../test-helpers/fakes';
import { FakeSaleRepository, FakeSalesUnitOfWork, FakeSalesWorld, FakeStockAlertRepository, WorldSku, makeAuth } from '../../../test-helpers/salesFakes';
import { ConflictError } from '../../../utils/exeptions/ConflictError';
import { ForbiddenError } from '../../../utils/exeptions/ForbiddenError';
import { InsufficientStockError } from '../../../utils/exeptions/InsufficientStockError';
import { NotFoundError } from '../../../utils/exeptions/NotFoundError';
import { ValidationError } from '../../../utils/exeptions/ValidationError';
import { randomUUID } from 'node:crypto';
import { CreateSaleUsecase } from '../CreateSaleUsecase';

describe('CreateSaleUsecase', () => {
    let world: FakeSalesWorld;
    let hamra: Branch;
    let tripoli: Branch;
    let dress: WorldSku;
    let cap: WorldSku;
    let useCase: CreateSaleUsecase;
    const clock = () => new Date('2026-10-27T10:00:00Z');
    const employee = () => makeAuth(UserRole.EMPLOYEE, [hamra.getId()]);
    const manager = () => makeAuth(UserRole.MANAGER, [hamra.getId(), tripoli.getId()]);
    const key = () => `sale-${randomUUID()}`;

    const body = (patch: Record<string, unknown> = {}) => ({
        branchId: hamra.getId(),
        lines: [{ skuId: dress.skuId, quantity: 1 }],
        payments: [{ method: 'cash', amount: '45.00' }],
        ...patch,
    });

    beforeEach(() => {
        world = new FakeSalesWorld();
        hamra = Branch.create({ id: randomUUID(), code: 'HAMRA', name: 'Hamra' });
        tripoli = Branch.create({ id: randomUUID(), code: 'TRIPOLI', name: 'Tripoli' });
        dress = world.addSku({ priceCents: 4500 });
        cap = world.addSku({ priceCents: 1200, styleName: 'Basic Cap', size: 'One size', color: 'Black' });
        world.setStock(hamra.getId(), dress.skuId, 8);
        world.setStock(hamra.getId(), cap.skuId, 3);
        useCase = new CreateSaleUsecase(
            new FakeSalesUnitOfWork(world),
            new FakeBranchRepository([hamra, tripoli]),
            new FakeSaleRepository(world),
            new FakeStockAlertRepository(world),
            clock,
        );
    });

    describe('a normal sale', () => {
        it('the worked example of BL-04: 1 dress at 45.00 paid 20.00 cash + 25.00 Whish, stock 8 -> 7, recorded ONCE', async () => {
            const auth = employee();
            const { sale, replayed } = await useCase.execute(body({ payments: [{ method: 'cash', amount: '20', tendered: '50' }, { method: 'whish', amount: '25.00', reference: 'WH-123' }] }), key(), auth);

            expect(replayed).toBe(false);
            expect([sale.subtotalCents, sale.discountCents, sale.totalCents]).toEqual([4500, 0, 4500]);
            expect(sale.payments.map((p) => [p.method, p.amountCents, p.tenderedCents, p.whishReference])).toEqual([['cash', 2000, 5000, null], ['whish', 2500, null, 'WH-123']]);
            expect(sale.soldBy).toBe(auth.user.getId());
            expect(sale.businessDate).toBe('2026-10-27');
            expect(sale.channel).toBe('in_store');
            expect(world.quantity(hamra.getId(), dress.skuId)).toBe(7);
            expect(world.ledger).toEqual([expect.objectContaining({ type: 'sale', delta: -1, balanceAfter: 7, saleId: sale.id })]);
            expect(world.sales.size).toBe(1);
        });

        it('the price comes from the catalog (the database), and a price the client sends is ignored', async () => {
            const { sale } = await useCase.execute(body({ lines: [{ skuId: dress.skuId, quantity: 2, unitPrice: '1.00', price: 1 }], payments: [{ method: 'cash', amount: '90' }] }), key(), employee());
            expect(sale.lines[0].unitPriceCents).toBe(4500);
            expect(sale.totalCents).toBe(9000);
        });

        it('a later catalog price change never rewrites an old sale', async () => {
            const { sale } = await useCase.execute(body(), key(), employee());
            dress.priceCents = 9999;
            expect((await new FakeSaleRepository(world).findById(sale.id))!.lines[0].unitPriceCents).toBe(4500);
        });

        it('several lines: stock goes down for each, one ledger row each', async () => {
            await useCase.execute(body({ lines: [{ skuId: dress.skuId, quantity: 2 }, { skuId: cap.skuId, quantity: 3 }], payments: [{ method: 'cash', amount: '126' }] }), key(), employee());
            expect(world.quantity(hamra.getId(), dress.skuId)).toBe(6);
            expect(world.quantity(hamra.getId(), cap.skuId)).toBe(0);
            expect(world.ledger).toHaveLength(2);
        });

        it('selling the LAST unit is allowed, and leaves exactly zero', async () => {
            world.setStock(hamra.getId(), dress.skuId, 1);
            await useCase.execute(body(), key(), employee());
            expect(world.quantity(hamra.getId(), dress.skuId)).toBe(0);
        });

        it('cash given and change; a sale paid only with Whish; a free sale', async () => {
            const cash = await useCase.execute(body({ payments: [{ method: 'cash', amount: 45, tendered: '50' }] }), key(), employee());
            expect(cash.sale.payments[0]).toMatchObject({ amountCents: 4500, tenderedCents: 5000 });
            const whish = await useCase.execute(body({ payments: [{ method: 'whish', amount: '45', reference: 'WH-9' }] }), key(), employee());
            expect(whish.sale.payments[0].method).toBe('whish');
            const free = await useCase.execute(body({ lines: [{ skuId: dress.skuId, quantity: 1, discount: { type: 'percent', percent: '100', reason: 'gift' } }], payments: [] }), key(), manager());
            expect(free.sale.totalCents).toBe(0);
        });

        it('the social media channel is recorded with its platform', async () => {
            const { sale } = await useCase.execute(body({ channel: 'social_media', socialPlatform: 'instagram', note: ' delivery ' }), key(), employee());
            expect([sale.channel, sale.socialPlatform, sale.note]).toEqual(['social_media', 'instagram', 'delivery']);
        });
    });

    describe('discounts need a manager (BL-04)', () => {
        const percent = { type: 'percent', percent: '10', reason: 'holiday' };

        it('an employee asking for a discount is refused and nothing happens', async () => {
            const attempt = useCase.execute(body({ lines: [{ skuId: dress.skuId, quantity: 1, discount: percent }], payments: [{ method: 'cash', amount: '40.50' }] }), key(), employee());
            await expect(attempt).rejects.toThrow('Missing permission: discounts.apply');
            expect(world.sales.size).toBe(0);
            expect(world.quantity(hamra.getId(), dress.skuId)).toBe(8);
        });

        it('a manager applies a percentage: the line shows the original price, the discount, the reason and WHO approved', async () => {
            const auth = manager();
            const { sale } = await useCase.execute(body({ lines: [{ skuId: dress.skuId, quantity: 1, discount: percent }], payments: [{ method: 'cash', amount: '40.50' }] }), key(), auth);
            expect(sale.lines[0]).toMatchObject({ unitPriceCents: 4500, lineTotalCents: 4050, reduction: { type: 'percent', percentHundredths: 1000, reason: 'holiday', approvedBy: auth.user.getId() } });
            expect([sale.subtotalCents, sale.discountCents, sale.totalCents]).toEqual([4500, 450, 4050]);
        });

        it('a manager overrides a price (never above the catalog price)', async () => {
            const override = (unitPrice: string) => useCase.execute(body({ lines: [{ skuId: dress.skuId, quantity: 1, discount: { type: 'override', unitPrice, reason: 'stain' } }], payments: [{ method: 'cash', amount: unitPrice }] }), key(), manager());
            expect((await override('40')).sale.lines[0].reduction).toMatchObject({ type: 'override', unitPriceCents: 4000 });
            await expect(override('45.01')).rejects.toBeInstanceOf(ValidationError);
            await expect(override('-1')).rejects.toBeInstanceOf(ValidationError);
        });

        it('a discount without a reason is refused', async () => {
            const attempt = useCase.execute(body({ lines: [{ skuId: dress.skuId, quantity: 1, discount: { type: 'percent', percent: '10' } }], payments: [{ method: 'cash', amount: '40.50' }] }), key(), manager());
            await expect(attempt).rejects.toBeInstanceOf(ValidationError);
        });
    });

    describe('not enough stock', () => {
        it('is a 409 that lists exactly the items that are short, and the sale leaves NOTHING behind', async () => {
            const attempt = useCase.execute(body({ lines: [{ skuId: dress.skuId, quantity: 2 }, { skuId: cap.skuId, quantity: 4 }], payments: [{ method: 'cash', amount: '138' }] }), 'short-key-1', employee());
            const error = await attempt.catch((e) => e);
            expect(error).toBeInstanceOf(InsufficientStockError);
            expect(error).toBeInstanceOf(ConflictError);
            expect(error.shortages).toEqual([{ skuId: cap.skuId, skuCode: cap.skuCode, requested: 4, available: 3 }]);

            expect(world.sales.size).toBe(0);
            expect(world.ledger).toHaveLength(0);
            expect(world.quantity(hamra.getId(), dress.skuId)).toBe(8);     // the dress line was fine, but it was undone too
            expect(world.quantity(hamra.getId(), cap.skuId)).toBe(3);
            expect(world.keys.size).toBe(0);                                 // the idempotency key was undone: the client may retry
        });

        it('the alert is kept even though the sale was rolled back, and a retry of the same request does not duplicate it', async () => {
            const auth = employee();                       // the same person retries
            const send = () => useCase.execute(body({ lines: [{ skuId: cap.skuId, quantity: 5 }], payments: [{ method: 'cash', amount: '60' }] }), 'short-key-2', auth);
            await expect(send()).rejects.toBeInstanceOf(InsufficientStockError);
            await expect(send()).rejects.toBeInstanceOf(InsufficientStockError);
            expect(world.alerts).toHaveLength(1);
            expect(world.alerts[0]).toMatchObject({ operation: 'sale.create', branchId: hamra.getId(), skuId: cap.skuId, requestedQuantity: 5, availableQuantity: 3, idempotencyKey: 'short-key-2' });
        });

        it('a sku never stocked at this branch counts as 0', async () => {
            const other = world.addSku();
            await expect(useCase.execute(body({ lines: [{ skuId: other.skuId, quantity: 1 }], payments: [{ method: 'cash', amount: '45' }] }), key(), employee())).rejects.toBeInstanceOf(InsufficientStockError);
        });

        it('stock at ANOTHER branch does not help', async () => {
            world.setStock(tripoli.getId(), cap.skuId, 100);
            await expect(useCase.execute(body({ lines: [{ skuId: cap.skuId, quantity: 4 }], payments: [{ method: 'cash', amount: '48' }] }), key(), employee())).rejects.toBeInstanceOf(InsufficientStockError);
        });
    });

    describe('retries (the idempotency key)', () => {
        it('the SAME request with the SAME key is not sold twice: same sale back, stock lowered once, replayed = true', async () => {
            const auth = employee();                       // ONE person who retries: the key belongs to the user
            const k = key();
            const first = await useCase.execute(body(), k, auth);
            const second = await useCase.execute(body(), k, auth);
            expect(first.replayed).toBe(false);
            expect(second.replayed).toBe(true);
            expect(second.sale.id).toBe(first.sale.id);
            expect(world.sales.size).toBe(1);
            expect(world.quantity(hamra.getId(), dress.skuId)).toBe(7);
            expect(world.ledger).toHaveLength(1);
        });

        it('the same key with ANOTHER request is refused (409), and nothing is sold', async () => {
            const auth = employee();
            const k = key();
            await useCase.execute(body(), k, auth);
            const other = useCase.execute(body({ lines: [{ skuId: dress.skuId, quantity: 2 }], payments: [{ method: 'cash', amount: '90' }] }), k, auth);
            await expect(other).rejects.toThrow('already used for a different request');
            expect(world.sales.size).toBe(1);
            expect(world.quantity(hamra.getId(), dress.skuId)).toBe(7);
        });

        it('two different people may use the same key text: the key belongs to the user', async () => {
            const k = 'same-key-text-1';
            await useCase.execute(body(), k, employee());
            await useCase.execute(body(), k, employee());
            expect(world.sales.size).toBe(2);
        });

        it('the key is required, 8 to 200 characters', async () => {
            for (const bad of [undefined, '', 'short', '   ', 'x'.repeat(201), 123]) {
                await expect(useCase.execute(body(), bad, employee())).rejects.toBeInstanceOf(ValidationError);
            }
            expect(world.sales.size).toBe(0);
        });
    });

    describe('payments', () => {
        it('must add up to the total exactly, otherwise nothing is sold', async () => {
            for (const payments of [[{ method: 'cash', amount: '44.99' }], [{ method: 'cash', amount: '45.01' }], [{ method: 'cash', amount: '20' }, { method: 'whish', amount: '20', reference: 'A1' }], []]) {
                await expect(useCase.execute(body({ payments }), key(), employee())).rejects.toBeInstanceOf(ValidationError);
            }
            expect(world.sales.size).toBe(0);
            expect(world.quantity(hamra.getId(), dress.skuId)).toBe(8);
        });

        it('a Whish reference can pay only ONE sale (any letter case), and the second sale is undone completely', async () => {
            await useCase.execute(body({ payments: [{ method: 'whish', amount: '45', reference: 'WH-777' }] }), key(), employee());
            const reuse = useCase.execute(body({ payments: [{ method: 'whish', amount: '45', reference: 'wh-777' }] }), key(), employee());
            await expect(reuse).rejects.toThrow('already used');
            expect(world.sales.size).toBe(1);
            expect(world.quantity(hamra.getId(), dress.skuId)).toBe(7);
        });

        it('refuses bad shapes: unknown method, cash given below the amount, Whish without reference, text amounts', async () => {
            const bad = [
                [{ method: 'card', amount: '45' }], [{ method: 'cash', amount: '45', tendered: '40' }], [{ method: 'whish', amount: '45' }],
                [{ method: 'cash', amount: 'abc' }], [{ method: 'cash', amount: '45', reference: 'X' }], [{ method: 'whish', amount: '45', reference: 'A', tendered: '45' }], ['cash'],
            ];
            for (const payments of bad) await expect(useCase.execute(body({ payments }), key(), employee()), JSON.stringify(payments)).rejects.toBeInstanceOf(ValidationError);
        });
    });

    describe('who, where and what', () => {
        it('an employee cannot sell at a branch that is not theirs (403) and nothing happens', async () => {
            const attempt = useCase.execute(body({ branchId: tripoli.getId() }), key(), employee());
            await expect(attempt).rejects.toBeInstanceOf(ForbiddenError);
            expect(world.sales.size).toBe(0);
        });

        it('an admin may sell at any branch; a manager only where granted', async () => {
            world.setStock(tripoli.getId(), dress.skuId, 5);
            const admin = makeAuth(UserRole.ADMIN);
            expect((await useCase.execute(body({ branchId: tripoli.getId() }), key(), admin)).sale.branchId).toBe(tripoli.getId());
            const hamraOnlyManager = makeAuth(UserRole.MANAGER, [hamra.getId()]);
            await expect(useCase.execute(body({ branchId: tripoli.getId() }), key(), hamraOnlyManager)).rejects.toBeInstanceOf(ForbiddenError);
        });

        it('unknown branch is 404, a closed branch is 409', async () => {
            const admin = makeAuth(UserRole.ADMIN);
            await expect(useCase.execute(body({ branchId: randomUUID() }), key(), admin)).rejects.toBeInstanceOf(NotFoundError);
            const closed = Branch.create({ id: randomUUID(), code: 'OLD', name: 'Old', isActive: false });
            const uc = new CreateSaleUsecase(new FakeSalesUnitOfWork(world), new FakeBranchRepository([closed]), new FakeSaleRepository(world), new FakeStockAlertRepository(world), clock);
            await expect(uc.execute(body({ branchId: closed.getId() }), key(), admin)).rejects.toBeInstanceOf(ConflictError);
        });

        it('unknown sku is 404; an inactive sku or style is 409; mixed currencies are 400', async () => {
            await expect(useCase.execute(body({ lines: [{ skuId: randomUUID(), quantity: 1 }] }), key(), employee())).rejects.toBeInstanceOf(NotFoundError);
            const retired = world.addSku({ skuActive: false });
            world.setStock(hamra.getId(), retired.skuId, 5);
            await expect(useCase.execute(body({ lines: [{ skuId: retired.skuId, quantity: 1 }] }), key(), employee())).rejects.toThrow('is not for sale');
            const oldStyle = world.addSku({ styleActive: false });
            world.setStock(hamra.getId(), oldStyle.skuId, 5);
            await expect(useCase.execute(body({ lines: [{ skuId: oldStyle.skuId, quantity: 1 }] }), key(), employee())).rejects.toBeInstanceOf(ConflictError);
            const euro = world.addSku({ currency: 'EUR' });
            world.setStock(hamra.getId(), euro.skuId, 5);
            await expect(useCase.execute(body({ lines: [{ skuId: dress.skuId, quantity: 1 }, { skuId: euro.skuId, quantity: 1 }], payments: [{ method: 'cash', amount: '100' }] }), key(), employee())).rejects.toBeInstanceOf(ValidationError);
        });

        it('every bad request body is a ValidationError (400), never a crash', async () => {
            const bad: unknown[] = [
                undefined, null, 'text', [], {}, body({ branchId: 'abc' }), body({ branchId: undefined }), body({ lines: [] }), body({ lines: 'x' }),
                body({ lines: [{ skuId: 'abc', quantity: 1 }] }), body({ lines: [{ skuId: dress.skuId, quantity: 0 }] }), body({ lines: [{ skuId: dress.skuId, quantity: 1.5 }] }),
                body({ lines: [{ skuId: dress.skuId, quantity: '1' }] }), body({ lines: [null] }), body({ lines: [{ skuId: dress.skuId, quantity: 1 }, { skuId: dress.skuId, quantity: 1 }] }),
                body({ payments: 'x' }), body({ payments: [null] }), body({ channel: 'online' }), body({ channel: 'social_media' }), body({ note: 5 }),
                body({ lines: [{ skuId: dress.skuId, quantity: 1, discount: 'x' }] }), body({ lines: [{ skuId: dress.skuId, quantity: 1, discount: { type: 'free' } }] }),
            ];
            for (const input of bad) await expect(useCase.execute(input, key(), manager()), JSON.stringify(input)).rejects.toBeInstanceOf(ValidationError);
            expect(world.sales.size).toBe(0);
        });
    });
});
