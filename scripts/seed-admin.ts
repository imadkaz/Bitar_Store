// scripts/seed-admin.ts   (ضيف بـ package.json: "seed:admin": "tsx scripts/seed-admin.ts")
import 'dotenv/config';
import { prisma } from '../src/db';
import { UserRole, normalizeEmail } from '../src/models/User.model';
import { UserRepository } from '../src/repositories/UserRepository';
import { CreateUserUsecase } from '../src/usecases/user/CreateUserUsecase';

async function main() {
    const { ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME } = process.env;
    if (!ADMIN_EMAIL || !ADMIN_PASSWORD) throw new Error('Set ADMIN_EMAIL and ADMIN_PASSWORD in .env first');

    const userRepository = new UserRepository(prisma);
    if (await userRepository.findByEmail(normalizeEmail(ADMIN_EMAIL))) {
        console.log(`admin ${ADMIN_EMAIL} already exists, nothing to do`);
        return;
    }

    const admin = await new CreateUserUsecase(userRepository).execute(
        { email: ADMIN_EMAIL, fullName: ADMIN_NAME ?? 'Admin', role: UserRole.ADMIN },
        null,
    );
    console.log(`created admin ${admin.getEmail()} (id: ${admin.getId()})`);
}

main()
    .catch((error) => {
        console.error(error.message ?? error);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());