// src/routes/index.ts
import { Router } from 'express';
import { UserController } from '../controllers/User.Controller';
import { prisma } from '../db';
import { createDevAuthenticate } from '../middlewares/Authenticate';
import { UserRepository } from '../repositories/UserRepository';
import { CreateUserUsecase } from '../usecases/user/CreateUserUsecase';
import { ListUsersUsecase } from '../usecases/user/ListUsersUsecase';
import { UpdateUserUsecase } from '../usecases/user/UpdateUserUsecase';
import { UserRoutes } from './User.Route';
import { GrantBranchAccessUsecase } from '../usecases/user/GrantBranchAccessUsecase';
import { RevokeBranchAccessUsecase } from '../usecases/user/RevokeBranchAccessUsecase';
import { BranchRepository } from '../repositories/BranchRepository';
import { UserAccessRepository } from '../repositories/UserAccessRepository';
import { ListBranchesUsecase } from '../usecases/branch/ListBranchesUsecase';
import { CreateBranchUsecase } from '../usecases/branch/CreateBranchUsecase';
import { BranchController } from '../controllers/Branch.Controller';
import { BranchRoutes } from './Branch.Routes';
import { DeleteUserUsecase } from '../usecases/user/DeleteUserUsecase';
import { SetUserPasswordUsecase } from '../usecases/user/SetUserPasswordUsecase';

// Composition root: the only place that creates repositories -> use cases -> controllers -> routes.
export const routes = Router();

// ---- shared
const userRepository = new UserRepository(prisma);
const branchRepository = new BranchRepository(prisma);
const userAccessRepository = new UserAccessRepository(prisma);  
const authenticate = createDevAuthenticate(userRepository);   

// ---- users
const userController = new UserController(
    new CreateUserUsecase(userRepository),
    new ListUsersUsecase(userRepository),
    new UpdateUserUsecase(userRepository),
    new GrantBranchAccessUsecase(userRepository, branchRepository, userAccessRepository),
    new RevokeBranchAccessUsecase(userRepository, userAccessRepository),
    new DeleteUserUsecase(userRepository),
    new SetUserPasswordUsecase(userRepository)
);

    const branchController = new BranchController(
        new CreateBranchUsecase(branchRepository),
        new ListBranchesUsecase(branchRepository),
    );

routes.use('/users', UserRoutes(userController, authenticate));
routes.use('/branches', BranchRoutes(branchController, authenticate));

