import { beforeEach, describe, expect, it } from 'vitest';
import { AuthContext } from '../../models/AuthContext';
import { resolvePermissions } from '../../models/Permission';
import { User, UserRole } from '../../models/User.model';
import { FakeBranchRepository, makeBranch, makeUser } from '../../test-helpers/fakes';
import { ConflictError } from '../../utils/exeptions/ConflictError';
import { ValidationError } from '../../utils/exeptions/ValidationError';
import { CreateBranchUsecase } from './CreateBranchUsecase';
import { ListBranchesUsecase } from './ListBranchesUsecase';

// "Who is asking, and which branches were granted to them": the same object the authenticate middleware builds.
const asking = (user: User, grantedBranchIds: string[] = []) =>
    new AuthContext(user, resolvePermissions(user.getRole(), []), new Set(grantedBranchIds));

describe('CreateBranchUsecase', () => {
    let repo: FakeBranchRepository;

    beforeEach(() => {
        repo = new FakeBranchRepository();
    });

    it('uppercases and trims the code', async () => {
        const branch = await new CreateBranchUsecase(repo).execute({ code: ' hamra-1 ', name: 'Hamra' }, 'admin-1');
        expect(branch.getCode()).toBe('HAMRA-1');
        expect((await repo.findByCode('HAMRA-1'))?.getName()).toBe('Hamra');
    });

    it('refuses a duplicate code, whatever its letter case', async () => {
        const create = new CreateBranchUsecase(repo);
        await create.execute({ code: 'HAMRA', name: 'Hamra' }, 'admin-1');
        await expect(create.execute({ code: 'hamra', name: 'Other' }, 'admin-1')).rejects.toBeInstanceOf(ConflictError);
    });

    it('refuses invalid codes and names', async () => {
        const create = new CreateBranchUsecase(repo);
        await expect(create.execute({ code: 'bad code!', name: 'x' }, 'a')).rejects.toBeInstanceOf(ValidationError);
        await expect(create.execute({ code: '', name: 'x' }, 'a')).rejects.toBeInstanceOf(ValidationError);
        await expect(create.execute({ code: 'OK', name: '  ' }, 'a')).rejects.toBeInstanceOf(ValidationError);
    });
});

describe('ListBranchesUsecase', () => {
    const hamra = makeBranch({ code: 'HAMRA' });
    const tripoli = makeBranch({ code: 'TRIPOLI' });
    const closed = makeBranch({ code: 'OLD', isActive: false });
    let list: ListBranchesUsecase;

    beforeEach(() => {
        list = new ListBranchesUsecase(new FakeBranchRepository([hamra, tripoli, closed]));
    });

    it('an admin sees every branch, including inactive ones', async () => {
        const admin = makeUser({ role: UserRole.ADMIN });
        expect((await list.execute(asking(admin))).map((b) => b.getCode()).sort()).toEqual(['HAMRA', 'OLD', 'TRIPOLI']);
    });

    it('an employee sees only the active branches granted to them', async () => {
        const result = await list.execute(asking(makeUser(), [hamra.getId(), closed.getId()]));
        expect(result.map((b) => b.getCode())).toEqual(['HAMRA']);   // OLD was granted but is inactive
    });

    it('an employee with no granted branch sees nothing', async () => {
        expect(await list.execute(asking(makeUser()))).toEqual([]);
    });

    it('a manager is NOT treated like an admin: only granted branches', async () => {
        const result = await list.execute(asking(makeUser({ role: UserRole.MANAGER }), [tripoli.getId()]));
        expect(result.map((b) => b.getCode())).toEqual(['TRIPOLI']);
    });

    it('a granted id that no longer exists is simply ignored', async () => {
        const result = await list.execute(asking(makeUser(), ['00000000-0000-4000-8000-000000000000', hamra.getId()]));
        expect(result.map((b) => b.getCode())).toEqual(['HAMRA']);
    });
});