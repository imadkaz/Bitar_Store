export interface DashboardOverviewData {
    stock: {
        products: number;
        variantsInStock: number;
        totalUnits: number;
        lowStock: number;
        outOfStock: number;
    };
    locations: {
        warehouses: number;
        branches: number;
    };
    today: {
        docs: number;
        revenueCents: number;
    };
}

export interface IDashboardRepository {
    overview(branchIds: string[], businessDate: string): Promise<DashboardOverviewData>;
}
