// src/routes/index.ts
import { Router } from 'express';
import { UserController } from '../controllers/User.Controller';
import { prisma } from '../db';
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
import { createAuthenticate } from '../middlewares/Authenticate';
import { GetAuthContextUsecase } from '../usecases/auth/GetAuthContextUsecase';
import { JwtTokenService } from '../services/JwtTokenService';
import config from '../config';
import { AuthController } from '../controllers/AuthController';
import { LoginUsecase } from '../usecases/auth/LoginUsecase';
import { AuthRoutes } from './Auth.Routes';

// Composition root: the only place that creates repositories -> use cases -> controllers -> routes.
export const routes = Router();

// ---- shared
const userRepository = new UserRepository(prisma);
const branchRepository = new BranchRepository(prisma);
const userAccessRepository = new UserAccessRepository(prisma);  
 const tokenService = new JwtTokenService(config.jwtSecret, config.jwtExpiresIn);
   const authenticate = createAuthenticate(
       new GetAuthContextUsecase(userRepository, userAccessRepository),
       tokenService,
       { allowDevHeader: config.authMode === 'dev' },
   );


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
   const authController = new AuthController(new LoginUsecase(userRepository, tokenService));

routes.use('/users', UserRoutes(userController, authenticate));
routes.use('/branches', BranchRoutes(branchController, authenticate));
routes.use('/auth', AuthRoutes(authController, authenticate));
