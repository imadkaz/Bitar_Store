// Paying in Lebanese pounds. Prices are in dollars; the rate (LBP for one dollar) and the rounding step are settings of the managers.
export interface Fx { rate: number; step: number }

// dollars (in cents) -> pounds, rounded to the NEAREST multiple of the step (half goes up). Exact integer arithmetic: no floating point.
export function usdCentsToLbp(cents: number, fx: Fx): number {
    const step = BigInt(fx.step);
    const lbpTimes100 = BigInt(cents) * BigInt(fx.rate);               // pounds x 100
    return Number(((2n * lbpTimes100 + 100n * step) / (200n * step)) * step);
}
