import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Branch } from '../../../models/Branch.model';
import { UserRole } from '../../../models/User.model';
import { DashboardOverviewData } from '../../../repositories/interfaces/IDashboardRepository';
import { FakeBranchRepository } from '../../../test-helpers/fakes';
import { makeAuth } from '../../../test-helpers/salesFakes';
import { ForbiddenError } from '../../../utils/exeptions/ForbiddenError';
import { ValidationError } from '../../../utils/exeptions/ValidationError';
import { GetDashboardOverviewUsecase } from '../GetDashboardOverviewUsecase';

describe('dashboard overview', () => {
    const branch = Branch.create({ id: randomUUID(), code: 'HAMRA', name: 'Hamra' });
    const otherBranch = Branch.create({ id: randomUUID(), code: 'TRIPOLI', name: 'Tripoli' });
    const received: { branchIds?: string[]; businessDate?: string } = {};
    const data: DashboardOverviewData = {
        stock: { products: 4, variantsInStock: 6, totalUnits: 14, lowStock: 2, outOfStock: 1 },
        locations: { warehouses: 1, branches: 2 },
        today: { docs: 3, revenueCents: 12550 },
    };
    const branches = new FakeBranchRepository([branch, otherBranch]);
    const dashboard = {
        async overview(branchIds: string[], businessDate: string) {
            received.branchIds = branchIds;
            received.businessDate = businessDate;
            return data;
        },
    };

    it('returns dashboard metrics for accessible branches and the current business day', async () => {
        const usecase = new GetDashboardOverviewUsecase(branches, dashboard, () => new Date('2026-10-29T22:30:00Z'));
        const result = await usecase.execute({}, makeAuth(UserRole.MANAGER, [branch.getId()]));

        expect(received).toEqual({ branchIds: [branch.getId()], businessDate: '2026-10-30' });
        expect(result).toEqual({
            stock: data.stock,
            locations: data.locations,
            today: { docs: 3, revenue: '125.50' },
        });
    });

    it('validates a requested branch and refuses branches outside the caller scope', async () => {
        const usecase = new GetDashboardOverviewUsecase(branches, dashboard);
        const manager = makeAuth(UserRole.MANAGER, [branch.getId()]);

        await expect(usecase.execute({ branchId: 'not-a-uuid' }, manager)).rejects.toBeInstanceOf(ValidationError);
        await expect(usecase.execute({ branchId: otherBranch.getId() }, manager)).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('requires the financial reports permission', async () => {
        const usecase = new GetDashboardOverviewUsecase(branches, dashboard);
        await expect(usecase.execute({}, makeAuth(UserRole.EMPLOYEE, [branch.getId()]))).rejects.toBeInstanceOf(ForbiddenError);
    });
});
