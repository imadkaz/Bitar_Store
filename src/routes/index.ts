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
import { BarcodeRepository } from '../repositories/BarcodeRepository';
import { SkuRepository } from '../repositories/SkuRepository';
import { StyleRepository } from '../repositories/StyleRepository';
import { UpdateStyleUsecase } from '../usecases/styles/UpdateStyleUsecase';
import { GetStyleUsecase } from '../usecases/styles/GetStyleUsecase';
import { ListStylesUsecase } from '../usecases/styles/ListStylesUsecase';
import { CreateStyleUsecase } from '../usecases/styles/CreateStyleUsecase';
import { StyleController } from '../controllers/StyleController';
import { StyleRoutes } from './Style.Routes';
import { RemoveBarcodeUsecase } from '../usecases/barcodes/RemoveBarcodeUsecase';
import { AddBarcodeUsecase } from '../usecases/barcodes/AddBarcodeUsecase';
import { GetPriceHistoryUsecase } from '../usecases/skus/GetPriceHistoryUsecase';
import { ChangeSkuPriceUsecase } from '../usecases/skus/ChangeSkuPriceUsecase';
import { UpdateSkuUsecase } from '../usecases/skus/UpdateSkuUsecase';
import { LookupSkuUsecase } from '../usecases/skus/LookupSkuUsecase';
import { GetSkuUsecase } from '../usecases/skus/GetSkuUsecase';
import { ListSkusUsecase } from '../usecases/skus/ListSkusUsecase';
import { CreateSkuUsecase } from '../usecases/skus/CreateSkuUsecase';
import { SkuController } from '../controllers/SkuController';
import { BarcodeRoutes } from './Barcode.Routes';
import { SkuRoutes } from './Sku.Routes';
import { SaleRoutes } from './Sale.Routes';
import { StockRoutes } from './Stock.Routes';
import { ListSalesUsecase } from '../usecases/sales/ListSalesUsecase';
import { GetSaleUsecase } from '../usecases/sales/GetSaleUsecase';
import { SalesUnitOfWork } from '../repositories/SalesUnitOfWork';
import { SaleController } from '../controllers/SaleController';
import { CreateSaleUsecase } from '../usecases/sales/CreateSaleUsecase';
import { SetOpeningStockUsecase } from '../usecases/stock/SetOpeningStockUsecase';
import { ListStockUsecase } from '../usecases/stock/ListStockUsecase';
import { StockController } from '../controllers/StockController';
import { SaleRepository } from '../repositories/SaleRepository';
import { StockRepository } from '../repositories/StockRepository';
import { StockAlertRepository } from '../repositories/StockAlertRepository';
import { StockQueryRepository } from '../repositories/StockQueryRepository';
import { ReportRepository } from '../repositories/ReportRepository';
import { StockInsightController, ReorderLevelController, ReportController, AuditController } from '../controllers/InsightControllers';
import { AuditRepository } from '../repositories/AuditRepository';
import { ReorderLevelRepository } from '../repositories/ReorderLevelRepository';
import { GetStockOverviewUsecase, ListStockMovementsUsecase, GetReplenishmentSuggestionsUsecase, GetSalesSummaryUsecase, GetTopSkusUsecase, ListAuditEventsUsecase } from '../usecases/insight/InsightUsecases';
import { ListReorderLevelsUsecase, SetReorderLevelUsecase, SetReorderLevelForStyleUsecase, DeleteReorderLevelUsecase } from '../usecases/reorder/ReorderLevelUsecases';
import { StockInsightRoutes, ReorderLevelRoutes, ReplenishmentRoutes, ReportRoutes, AuditRoutes } from './Insight.Routes';
import { LocationRepository } from '../repositories/LocationRepository';

// Composition root: the only place that creates repositories -> use cases -> controllers -> routes.
export const routes = Router();

// ---- shared
const userRepository = new UserRepository(prisma);
const branchRepository = new BranchRepository(prisma);
const userAccessRepository = new UserAccessRepository(prisma);  
const tokenService = new JwtTokenService(config.jwtSecret, config.jwtExpiresIn);
const styleRepository = new StyleRepository(prisma);
const skuRepository = new SkuRepository(prisma);
const barcodeRepository = new BarcodeRepository(prisma);

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

const styleController = new StyleController(
    new CreateStyleUsecase(styleRepository),
    new ListStylesUsecase(styleRepository),
    new GetStyleUsecase(styleRepository, skuRepository),
    new UpdateStyleUsecase(styleRepository)
);

const skuController = new SkuController(
    new CreateSkuUsecase(styleRepository, skuRepository),
    new ListSkusUsecase(skuRepository),
    new GetSkuUsecase(skuRepository, barcodeRepository),
    new LookupSkuUsecase(skuRepository, barcodeRepository),
    new UpdateSkuUsecase(skuRepository),
    new ChangeSkuPriceUsecase(skuRepository),
    new GetPriceHistoryUsecase(skuRepository),
    new AddBarcodeUsecase(skuRepository, barcodeRepository),
    new RemoveBarcodeUsecase(barcodeRepository),
);

const stockRepository = new StockRepository(prisma);
const saleRepository = new SaleRepository(prisma);

const stockController = new StockController(
    new ListStockUsecase(skuRepository, stockRepository),
    new SetOpeningStockUsecase(branchRepository, skuRepository, stockRepository),
);

const saleController = new SaleController(
    new CreateSaleUsecase(
        new SalesUnitOfWork(prisma), 
        branchRepository, saleRepository, 
        new StockAlertRepository(prisma)
    ),
    new GetSaleUsecase(saleRepository),
    new ListSalesUsecase(saleRepository),
);



const authController = new AuthController(
    new LoginUsecase(userRepository, tokenService)
);



const stockQueryRepository = new StockQueryRepository(prisma);
const reportRepository = new ReportRepository(prisma);
const reorderLevelRepository = new ReorderLevelRepository(prisma);
const locationRepository = new LocationRepository(prisma);

const stockInsightController = new StockInsightController(
    new GetStockOverviewUsecase(skuRepository, branchRepository, stockQueryRepository, reorderLevelRepository),
    new ListStockMovementsUsecase(branchRepository, stockQueryRepository),
);
const reorderLevelController = new ReorderLevelController(
    new ListReorderLevelsUsecase(branchRepository, reorderLevelRepository),
    new SetReorderLevelUsecase(branchRepository, skuRepository, reorderLevelRepository),
    new SetReorderLevelForStyleUsecase(branchRepository, styleRepository, reorderLevelRepository),
    new DeleteReorderLevelUsecase(reorderLevelRepository),
);
const reportController = new ReportController(
    new GetReplenishmentSuggestionsUsecase(branchRepository, locationRepository, reportRepository),
    new GetSalesSummaryUsecase(branchRepository, reportRepository),
    new GetTopSkusUsecase(branchRepository, reportRepository),
);





routes.use('/users', UserRoutes(userController, authenticate));
routes.use('/branches', BranchRoutes(branchController, authenticate));
routes.use('/styles', StyleRoutes(styleController, authenticate));
routes.use('/skus', SkuRoutes(skuController, authenticate));
routes.use('/barcodes', BarcodeRoutes(skuController, authenticate));
routes.use('/auth', AuthRoutes(authController, authenticate));
routes.use('/stock', StockRoutes(stockController, authenticate));
routes.use('/stock', StockInsightRoutes(stockInsightController, authenticate));
routes.use('/sales', SaleRoutes(saleController, authenticate));
routes.use('/reorder-levels', ReorderLevelRoutes(reorderLevelController, authenticate));
routes.use('/replenishment', ReplenishmentRoutes(reportController, authenticate));
routes.use('/reports', ReportRoutes(reportController, authenticate));
routes.use('/audit-events', AuditRoutes(new AuditController(new ListAuditEventsUsecase(new AuditRepository(prisma))), authenticate));

