// A remote database such as Neon goes to sleep when idle. The first connection can be dropped while it wakes up
// ("Connection terminated unexpectedly"). Run a trivial query a few times before the real tests start.
export async function waitForDatabase(
    prisma: { $queryRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<unknown> },
    attempts = 6,
    delayMs = 3000,
): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            await prisma.$queryRaw`SELECT 1`;
            return;
        } catch (error) {
            lastError = error;
            if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
    }
    throw lastError;
}
