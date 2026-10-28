import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { Branch } from '../../../models/Branch.model';
import { UserRole } from '../../../models/User.model';
import { FakeBranchRepository } from '../../../test-helpers/fakes';
import { FakeSaleRepository, FakeSalesUnitOfWork, FakeSalesWorld, FakeStockAlertRepository, makeAuth } from '../../../test-helpers/salesFakes';
import { ForbiddenError } from '../../../utils/exeptions/ForbiddenError';
import { NotFoundError } from '../../../utils/exeptions/NotFoundError';
import { ValidationError } from '../../../utils/exeptions/ValidationError';
import { CreateSaleUsecase } from '../CreateSaleUsecase';
import { GetSaleUsecase } from '../GetSaleUsecase';
import { ListSalesUsecase } from '../ListSalesUsecase';

describe('reading sales', () => {
    let world: FakeSalesWorld;
    let hamra: Branch;
    let tripoli: Branch;
    let saleHamra: string;
    let saleTripoli: string;
    let get: GetSaleUsecase;
    let list: ListSalesUsecase;
    const today = new Date('2026-10-27T10:00:00Z');

    beforeEach(async () => {
        world = new FakeSalesWorld();
        hamra = Branch.create({ id: randomUUID(), code: 'HAMRA', name: 'Hamra' });
        tripoli = Branch.create({ id: randomUUID(), code: 'TRIPOLI', name: 'Tripoli' });
        const sku = world.addSku({ priceCents: 1000 });
        world.setStock(hamra.getId(), sku.skuId, 50);
        world.setStock(tripoli.getId(), sku.skuId, 50);
        const sales = new FakeSaleRepository(world);
        const create = (date: Date) => new CreateSaleUsecase(new FakeSalesUnitOfWork(world), new FakeBranchRepository([hamra, tripoli]), sales, new FakeStockAlertRepository(world), () => date);
        const admin = makeAuth(UserRole.ADMIN);
        const sell = async (branch: Branch, date: Date) => (await create(date).execute({ branchId: branch.getId(), lines: [{ skuId: sku.skuId, quantity: 1 }], payments: [{ method: 'cash', amount: '10' }] }, `k-${randomUUID()}`, admin)).sale.id;
        saleHamra = await sell(hamra, today);
        saleTripoli = await sell(tripoli, today);
        await sell(hamra, new Date('2026-10-26T10:00:00Z'));         // yesterday at Hamra
        get = new GetSaleUsecase(sales);
        list = new ListSalesUsecase(sales, () => today);
    });

    it('a sale of a branch you do not reach looks like a sale that does not exist', async () => {
        const hamraStaff = makeAuth(UserRole.EMPLOYEE, [hamra.getId()]);
        expect((await get.execute(saleHamra, hamraStaff)).id).toBe(saleHamra);
        await expect(get.execute(saleTripoli, hamraStaff)).rejects.toBeInstanceOf(NotFoundError);
        await expect(get.execute(randomUUID(), hamraStaff)).rejects.toBeInstanceOf(NotFoundError);
        expect((await get.execute(saleTripoli, makeAuth(UserRole.ADMIN))).id).toBe(saleTripoli);
    });

    it('lists the sales of ONE branch on ONE shop day (today by default)', async () => {
        const staff = makeAuth(UserRole.EMPLOYEE, [hamra.getId()]);
        const todayList = await list.execute({ branchId: hamra.getId() }, staff);
        expect(todayList.businessDate).toBe('2026-10-27');
        expect(todayList.sales.map((s) => s.id)).toEqual([saleHamra]);
        const yesterday = await list.execute({ branchId: hamra.getId(), date: '2026-10-26' }, staff);
        expect(yesterday.sales).toHaveLength(1);
        expect((await list.execute({ branchId: hamra.getId(), date: '2026-10-25' }, staff)).sales).toEqual([]);
        expect((await list.execute({ branchId: hamra.getId(), limit: 1, offset: 1 }, staff)).sales).toEqual([]);
    });

    it('needs a branch you can see, a real date and sane paging', async () => {
        const staff = makeAuth(UserRole.EMPLOYEE, [hamra.getId()]);
        await expect(list.execute({ branchId: tripoli.getId() }, staff)).rejects.toBeInstanceOf(ForbiddenError);
        for (const input of [{}, { branchId: 'abc' }, { branchId: hamra.getId(), date: '2026-02-30' }, { branchId: hamra.getId(), date: 'today' }, { branchId: hamra.getId(), limit: 0 }, { branchId: hamra.getId(), limit: 201 }, { branchId: hamra.getId(), offset: -1 }]) {
            await expect(list.execute(input, staff), JSON.stringify(input)).rejects.toBeInstanceOf(ValidationError);
        }
    });
});
