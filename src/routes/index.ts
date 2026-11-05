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
import { CancelTransferUsecase, CreateTransferUsecase, DispatchTransferUsecase, GetTransferUsecase, ListTransfersUsecase, ReceiveTransferUsecase, ResolveTransferUsecase } from '../usecases/transfer/TransferUsecases';
import { TransferController } from '../controllers/TransferController';
import { TransferRepository } from '../repositories/TransferRepository';
import { TransferUnitOfWork } from '../repositories/TransferUnitOfWork';
import { TransferRoutes } from './Transfer.Routes';
import { AdjustmentController, CategoryController, DeletionController, GoodsReceiptController, InvoiceController, PermissionController, PlacesController, SalesHistoryController, WarehouseController } from '../controllers/ManagementControllers';
import { ManagementRepository } from '../repositories/ManagementRepository';
import { SalesHistoryRepository } from '../repositories/SalesHistoryRepository';
import { ListCategoriesUsecase, CreateCategoryUsecase, UpdateCategoryUsecase, DeleteCategoryUsecase, DeleteStyleUsecase, DeleteSkuUsecase, DeleteBranchUsecase, SoftDeleteUserUsecase, GetWarehouseUsecase, GetPermissionCatalogUsecase, GetUserPermissionsUsecase, SetUserPermissionsUsecase, GetBranchAccessUsecase, SetBranchAccessUsecase, ListPlacesUsecase } from '../usecases/management/ManagementUsecases';
import { ListSalesHistoryUsecase } from '../usecases/sales/ListSalesHistoryUsecase';
import { AdjustmentRoutes, CategoryRoutes, DeleteRoutes, GoodsReceiptRoutes, InvoiceRoutes, PermissionRoutes, PlacesRoutes, SalesHistoryRoutes, WarehouseRoutes } from './Management.Routes';
import { UpdateBranchUsecase } from '../usecases/branch/UpdateBranchUsecase';
import { AdjustmentUnitOfWork } from '../repositories/AdjustmentUnitOfWork';
import { AdjustmentRepository } from '../repositories/AdjustmentRepository';
import { CreateAdjustmentUsecase, ListAdjustmentsUsecase } from '../usecases/adjustments/AdjustmentUsecases';
import { GoodsReceiptRepository } from '../repositories/GoodsReceiptRepository';
import { GoodsReceiptUnitOfWork } from '../repositories/GoodsReceiptUnitOfWork';
import { CreateGoodsReceiptUsecase, GetGoodsReceiptUsecase, ListGoodsReceiptsUsecase } from '../usecases/goodsreceipts/GoodsReceiptUsecases';
import { InvoiceWriter } from '../repositories/InvoiceWriter';
import { InvoiceRepository } from '../repositories/InvoiceRepository';
import { GetInvoiceUsecase, CreateInvoiceUsecase, ListInvoicesUsecase, UpdateInvoiceUsecase, FinalizeInvoiceUsecase, VoidInvoiceUsecase, DeleteInvoiceUsecase, GetInvoicePdfUsecase } from '../usecases/invoices/InvoiceUsecases';

// Composition root: the only place that creates repositories -> use cases -> controllers -> routes.
export const routes = Router();

// ---- shared
const userRepository = new UserRepository(prisma);
const branchRepository = new BranchRepository(prisma);
const userAccessRepository = new UserAccessRepository(prisma);
const tokenService = new JwtTokenService(config.jwtSecret, config.jwtExpiresIn);
const styleRepository = new StyleRepository(prisma);
const stockRepository = new StockRepository(prisma);
const stockAlertRepository = new StockAlertRepository(prisma);
const saleRepository = new SaleRepository(prisma);
const salesUnitOfWork = new SalesUnitOfWork(prisma);
const salesHistoryRepository = new SalesHistoryRepository(prisma);
const skuRepository = new SkuRepository(prisma);
const barcodeRepository = new BarcodeRepository(prisma);
const stockQueryRepository = new StockQueryRepository(prisma);
const reportRepository = new ReportRepository(prisma);
const reorderLevelRepository = new ReorderLevelRepository(prisma);
const locationRepository = new LocationRepository(prisma);
const transferRepository = new TransferRepository(prisma);
const transferUnitOfWork = new TransferUnitOfWork(prisma);
const auditRepository = new AuditRepository(prisma);
const managementRepository = new ManagementRepository(prisma);
const adjustmentRepository = new AdjustmentRepository(prisma);
const adjustmentUnitOfWork = new AdjustmentUnitOfWork(prisma);
const goodsReceiptRepository = new GoodsReceiptRepository(prisma);
const goodsReceiptUnitOfWork = new GoodsReceiptUnitOfWork(prisma);
const invoiceRepository = new InvoiceRepository(prisma);
const invoiceWriter = new InvoiceWriter(prisma);

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
    new SetUserPasswordUsecase(userRepository),
);

// ---- branches (the second argument lets a branch be created as THE warehouse: only one)
const branchController = new BranchController(
    new CreateBranchUsecase(branchRepository, locationRepository),
    new ListBranchesUsecase(branchRepository),
    new UpdateBranchUsecase(branchRepository, locationRepository),
);

// ---- catalog
const styleController = new StyleController(
    new CreateStyleUsecase(styleRepository),
    new ListStylesUsecase(styleRepository),
    new GetStyleUsecase(styleRepository, skuRepository),
    new UpdateStyleUsecase(styleRepository),
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

// ---- stock and sales
const stockController = new StockController(
    new ListStockUsecase(skuRepository, stockRepository),
    new SetOpeningStockUsecase(branchRepository, skuRepository, stockRepository),
);

const saleController = new SaleController(
    new CreateSaleUsecase(
        salesUnitOfWork,
        branchRepository,
        saleRepository,
        stockAlertRepository,
    ),
    new GetSaleUsecase(saleRepository),
    new ListSalesUsecase(saleRepository),
);

const salesHistoryController = new SalesHistoryController(
    new ListSalesHistoryUsecase(branchRepository, salesHistoryRepository),
);

// ---- auth
const authController = new AuthController(
    new LoginUsecase(userRepository, tokenService),
);

// ---- the warehouse view: every place, minimums, what to send, reports, audit
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
const auditController = new AuditController(
    new ListAuditEventsUsecase(auditRepository),
);

const adjustmentController = new AdjustmentController(
    new CreateAdjustmentUsecase(adjustmentUnitOfWork, adjustmentRepository),
    new ListAdjustmentsUsecase(branchRepository, adjustmentRepository),
);

const goodsReceiptController = new GoodsReceiptController(
    new CreateGoodsReceiptUsecase(locationRepository, goodsReceiptUnitOfWork, goodsReceiptRepository),
    new GetGoodsReceiptUsecase(locationRepository, goodsReceiptRepository),
    new ListGoodsReceiptsUsecase(locationRepository, goodsReceiptRepository),
);

const getInvoiceUsecase = new GetInvoiceUsecase(invoiceRepository);
const invoiceController = new InvoiceController(
    new CreateInvoiceUsecase(invoiceWriter, invoiceRepository),
    getInvoiceUsecase,
    new ListInvoicesUsecase(invoiceRepository),
    new UpdateInvoiceUsecase(invoiceWriter, invoiceRepository),
    new FinalizeInvoiceUsecase(invoiceWriter, invoiceRepository),
    new VoidInvoiceUsecase(invoiceWriter, invoiceRepository),
    new DeleteInvoiceUsecase(invoiceWriter),
    new GetInvoicePdfUsecase(getInvoiceUsecase),
);

// ---- transfers
const transferController = new TransferController(
    new CreateTransferUsecase(transferUnitOfWork, transferRepository),
    new DispatchTransferUsecase(transferUnitOfWork, transferRepository, stockAlertRepository),
    new ReceiveTransferUsecase(transferUnitOfWork, transferRepository),
    new ResolveTransferUsecase(transferUnitOfWork, transferRepository),
    new CancelTransferUsecase(transferUnitOfWork, transferRepository),
    new GetTransferUsecase(transferRepository),
    new ListTransfersUsecase(transferRepository),
);

// ---- what the owner manages: categories, deleting, permissions, the warehouse lookup
const categoryController = new CategoryController(
    new ListCategoriesUsecase(managementRepository),
    new CreateCategoryUsecase(managementRepository),
    new UpdateCategoryUsecase(managementRepository),
    new DeleteCategoryUsecase(managementRepository),
);
const deleteController = new DeletionController(
    new DeleteStyleUsecase(managementRepository),
    new DeleteSkuUsecase(managementRepository),
    new DeleteBranchUsecase(managementRepository),
    new SoftDeleteUserUsecase(managementRepository),
);
const permissionController = new PermissionController(
    new GetPermissionCatalogUsecase(),
    new GetUserPermissionsUsecase(managementRepository),
    new SetUserPermissionsUsecase(managementRepository),
    new GetBranchAccessUsecase(managementRepository),
    new SetBranchAccessUsecase(managementRepository),
);
const warehouseController = new WarehouseController(
    new GetWarehouseUsecase(locationRepository),
);

const placesController = new PlacesController(
    new ListPlacesUsecase(branchRepository),
);

const deleteRoutes = DeleteRoutes(deleteController, authenticate);
const permissionRoutes = PermissionRoutes(permissionController, authenticate);

// ---- the routes
// ORDER MATTERS. Express answers with the FIRST router that matches. A router that does more than one thing
// (UserRoutes has a requireRole(admin) at its top, SaleRoutes has GET /:id) would swallow the new paths,
// so the specific routers come BEFORE the general one on the same prefix.

// users: delete (soft), permissions and branch access first, then the general user routes
routes.use('/users', deleteRoutes.users);
routes.use('/users', permissionRoutes.users);
routes.use('/permissions', permissionRoutes.catalog);
routes.use('/users', UserRoutes(userController, authenticate));

routes.use('/branches', deleteRoutes.branches);
routes.use('/branches', BranchRoutes(branchController, authenticate));

routes.use('/categories', CategoryRoutes(categoryController, authenticate));
routes.use('/styles', deleteRoutes.styles);
routes.use('/styles', StyleRoutes(styleController, authenticate));
routes.use('/skus', deleteRoutes.skus);
routes.use('/skus', SkuRoutes(skuController, authenticate));
routes.use('/barcodes', BarcodeRoutes(skuController, authenticate));

routes.use('/auth', AuthRoutes(authController, authenticate));

routes.use('/stock/adjustments', AdjustmentRoutes(adjustmentController, authenticate));
routes.use('/goods-receipts', GoodsReceiptRoutes(goodsReceiptController, authenticate));
routes.use('/invoices', InvoiceRoutes(invoiceController, authenticate));
routes.use('/stock', StockRoutes(stockController, authenticate));
routes.use('/stock', StockInsightRoutes(stockInsightController, authenticate));

// "/sales/history" BEFORE "/sales", or "/sales/:id" takes "history" as an id
routes.use('/sales/history', SalesHistoryRoutes(salesHistoryController, authenticate));
routes.use('/sales', SaleRoutes(saleController, authenticate));

routes.use('/reorder-levels', ReorderLevelRoutes(reorderLevelController, authenticate));
routes.use('/replenishment', ReplenishmentRoutes(reportController, authenticate));
routes.use('/reports', ReportRoutes(reportController, authenticate));
routes.use('/audit-events', AuditRoutes(auditController, authenticate));
routes.use('/transfers', TransferRoutes(transferController, authenticate));
routes.use('/warehouse', WarehouseRoutes(warehouseController, authenticate));
routes.use('/places', PlacesRoutes(placesController, authenticate));
