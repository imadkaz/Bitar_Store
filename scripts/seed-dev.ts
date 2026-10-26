// npm run seed:dev
// DEVELOPMENT DATA for testing the frontend: users in every state, branches, and who may see which branch.
// Safe to run twice: whatever already exists is skipped. It refuses to run in production.
import 'dotenv/config';
import { prisma } from '../src/db';
import { Branch } from '../src/models/Branch.model';
import { UserRole } from '../src/models/User.model';
import { BranchRepository } from '../src/repositories/BranchRepository';
import { UserAccessRepository } from '../src/repositories/UserAccessRepository';
import { UserRepository } from '../src/repositories/UserRepository';
import { CreateBranchUsecase } from '../src/usecases/branch/CreateBranchUsecase';
import { CreateUserUsecase } from '../src/usecases/user/CreateUserUsecase';
import { GrantBranchAccessUsecase } from '../src/usecases/user/GrantBranchAccessUsecase';
import { SetUserPasswordUsecase } from '../src/usecases/user/SetUserPasswordUsecase';
import { UpdateUserUsecase } from '../src/usecases/user/UpdateUserUsecase';
import { BarcodeRepository } from '../src/repositories/BarcodeRepository';
import { SkuRepository } from '../src/repositories/SkuRepository';
import { StyleRepository } from '../src/repositories/StyleRepository';
import { AddBarcodeUsecase } from '../src/usecases/barcodes/AddBarcodeUsecase';
import { CreateSkuUsecase } from '../src/usecases/skus/CreateSkuUsecase';
import { CreateStyleUsecase } from '../src/usecases/styles/CreateStyleUsecase';
import { UpdateSkuUsecase } from '../src/usecases/skus/UpdateSkuUsecase';
import { UpdateStyleUsecase } from '../src/usecases/styles/UpdateStyleUsecase';

const PASSWORD = 'Password#123';

async function main() {
    if (process.env.NODE_ENV === 'production') throw new Error('seed:dev must never run in production');

    const users = new UserRepository(prisma);
    const branches = new BranchRepository(prisma);
    const access = new UserAccessRepository(prisma);
    const createUser = new CreateUserUsecase(users);
    const setPassword = new SetUserPasswordUsecase(users);
    const updateUser = new UpdateUserUsecase(users);
    const createBranch = new CreateBranchUsecase(branches);
    const grant = new GrantBranchAccessUsecase(users, branches, access);

    // 1) the admin everything else is created by
    let admin = await users.findByEmail('admin@bitar.test');
    if (!admin) admin = await createUser.execute({ email: 'admin@bitar.test', fullName: 'Admin', role: UserRole.ADMIN }, null);
    if (!admin.hasPassword()) await setPassword.execute(admin.getId(), PASSWORD, null);
    const actor = admin.getId();

    // 2) users in every state the UI has to handle
    const people: { email: string; fullName: string; role: UserRole; password: boolean; active: boolean }[] = [
        { email: 'manager@bitar.test', fullName: 'Karim Manager', role: UserRole.MANAGER, password: true, active: true },
        { email: 'employee@bitar.test', fullName: 'Sara Employee', role: UserRole.EMPLOYEE, password: true, active: true },
        { email: 'nobranch@bitar.test', fullName: 'Nour NoBranch', role: UserRole.EMPLOYEE, password: true, active: true },
        { email: 'nopassword@bitar.test', fullName: 'Pending Password', role: UserRole.EMPLOYEE, password: false, active: true },
        { email: 'inactive@bitar.test', fullName: 'Old Employee', role: UserRole.EMPLOYEE, password: true, active: false },
    ];
    for (const p of people) {
        let user = await users.findByEmail(p.email);
        if (!user) user = await createUser.execute({ email: p.email, fullName: p.fullName, role: p.role }, actor);
        if (p.password && !user.hasPassword()) await setPassword.execute(user.getId(), PASSWORD, actor);
        if (!p.active && user.isActive()) await updateUser.execute({ id: user.getId(), isActive: false }, actor);
    }

    // 3) branches, one of them closed
    for (const b of [{ code: 'HAMRA', name: 'Hamra' }, { code: 'TRIPOLI', name: 'Tripoli' }, { code: 'WAREHOUSE', name: 'Main Warehouse' }, { code: 'CLOSED', name: 'Closed Branch' }]) {
        if (!(await branches.findByCode(b.code))) await createBranch.execute(b, actor);
    }
    const closed = (await branches.findByCode('CLOSED'))!;
    if (closed.isActive()) {
        const old: Branch = closed;
        old.deactivate();
        await branches.update(old, actor);
    }

    // 4) who may work in which branch (the admin reaches all of them without a row)
    const grants: [string, string][] = [['manager@bitar.test', 'HAMRA'], ['manager@bitar.test', 'TRIPOLI'], ['employee@bitar.test', 'HAMRA']];
    for (const [email, code] of grants) {
        await grant.execute((await users.findByEmail(email))!.getId(), (await branches.findByCode(code))!.getId(), actor);
    }

    // 5) a small catalog: styles with their size/color variants, barcodes, and one retired collection
    const styleRepo = new StyleRepository(prisma);
    const skuRepo = new SkuRepository(prisma);
    const barcodeRepo = new BarcodeRepository(prisma);
    const catalog: { code: string; name: string; category: string; price: string; variants: [string, string][]; active?: boolean }[] = [
        { code: 'NK-CLUB', name: 'Nike Club Tee', category: 'Clothing', price: '25.00', variants: [['S', 'Red'], ['M', 'Red'], ['L', 'Red'], ['M', 'Blue']] },
        { code: 'JEAN-SLIM', name: 'Slim Jeans', category: 'Clothing', price: '45.00', variants: [['30', 'Blue'], ['32', 'Blue'], ['34', 'Blue']] },
        { code: 'CAP-BASIC', name: 'Basic Cap', category: 'Accessories', price: '12.00', variants: [['One size', 'Black']] },
        { code: 'OLD-JACKET', name: 'Old Collection Jacket', category: 'Clothing', price: '80.00', variants: [['M', 'Grey']], active: false },
    ];
    for (const item of catalog) {
        let style = await styleRepo.findByCode(item.code);
        if (!style) style = await new CreateStyleUsecase(styleRepo).execute({ code: item.code, name: item.name, category: item.category }, actor);
        for (const [size, color] of item.variants) {
            const skuCode = `${item.code}-${size}-${color}`.toUpperCase().replace(/\s+/g, '');
            if (!(await skuRepo.findBySkuCode(skuCode))) {
                await new CreateSkuUsecase(styleRepo, skuRepo).execute({ styleId: style.getId(), skuCode, size, color, standardPrice: item.price }, actor);
            }
        }
        if (item.active === false) {
            for (const sku of await skuRepo.listByStyle(style.getId())) if (sku.isActive()) await new UpdateSkuUsecase(skuRepo).execute({ id: sku.getId(), isActive: false }, actor);
            if (style.isActive()) await new UpdateStyleUsecase(styleRepo).execute({ id: style.getId(), isActive: false }, actor);
        }
    }
    const barcodes: [string, string][] = [['NK-CLUB-S-RED', '5901234123457'], ['NK-CLUB-M-RED', '5901234123464'], ['NK-CLUB-L-RED', '5901234123471'], ['JEAN-SLIM-32-BLUE', '5901234123488'], ['CAP-BASIC-ONESIZE-BLACK', '5901234123495']];
    for (const [skuCode, code] of barcodes) {
        const sku = await skuRepo.findBySkuCode(skuCode);
        if (sku && !(await barcodeRepo.findByCode(code))) await new AddBarcodeUsecase(skuRepo, barcodeRepo).execute(sku.getId(), code, actor);
    }

    console.log('dev data ready. Every account uses the password ' + PASSWORD);
    console.log('  admin@bitar.test        admin     sees every branch');
    console.log('  manager@bitar.test      manager   HAMRA, TRIPOLI');
    console.log('  employee@bitar.test     employee  HAMRA');
    console.log('  nobranch@bitar.test     employee  no branch (empty state)');
    console.log('  nopassword@bitar.test   employee  cannot log in yet (hasPassword: false)');
    console.log('  inactive@bitar.test     employee  deactivated (login refused)');
    console.log('catalog: 4 styles (one retired), 9 skus, 5 barcodes. Try the scanner: GET /skus/lookup?code=5901234123457');
}

main()
    .catch((error) => {
        console.error(error.message ?? error);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
