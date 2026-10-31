import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Branch, BranchKind } from '../../../models/Branch.model';
import { UserRole } from '../../../models/User.model';
import { FakeBranchRepository } from '../../../test-helpers/fakes';
import { FakeSaleRepository, FakeSalesUnitOfWork, FakeSalesWorld, FakeStockAlertRepository, makeAuth } from '../../../test-helpers/salesFakes';
import { ConflictError } from '../../../utils/exeptions/ConflictError';
import { CreateSaleUsecase } from '../CreateSaleUsecase';

describe('the warehouse does not sell to customers', () => {
    it('a customer sale at the warehouse is refused before anything is touched; the same sale at a branch works', async () => {
        const world = new FakeSalesWorld();
        const warehouse = Branch.create({ id: randomUUID(), code: 'WH', name: 'Warehouse', kind: BranchKind.WAREHOUSE });
        const hamra = Branch.create({ id: randomUUID(), code: 'HAMRA', name: 'Hamra' });
        const sku = world.addSku({ priceCents: 1000 });
        world.setStock(warehouse.getId(), sku.skuId, 50);
        world.setStock(hamra.getId(), sku.skuId, 5);
        const useCase = new CreateSaleUsecase(new FakeSalesUnitOfWork(world), new FakeBranchRepository([warehouse, hamra]), new FakeSaleRepository(world), new FakeStockAlertRepository(world));
        const admin = makeAuth(UserRole.ADMIN);
        const sale = (branch: Branch) => useCase.execute({ branchId: branch.getId(), lines: [{ skuId: sku.skuId, quantity: 1 }], payments: [{ method: 'cash', amount: '10' }] }, `key-${randomUUID()}`, admin);

        const refused = sale(warehouse);
        await expect(refused).rejects.toBeInstanceOf(ConflictError);
        await expect(refused).rejects.toThrow('The warehouse does not sell to customers');
        expect(world.quantity(warehouse.getId(), sku.skuId)).toBe(50);
        expect(world.sales.size).toBe(0);

        await sale(hamra);
        expect(world.quantity(hamra.getId(), sku.skuId)).toBe(4);
    });
});
