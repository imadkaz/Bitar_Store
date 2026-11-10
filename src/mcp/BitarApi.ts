// A READ-ONLY client of the Bitar API for the MCP server. It can only GET, only the paths of the allow-list, and it signs in with the account given
// in the environment (use a manager account). The token lives in memory only: it is never printed, never logged, never returned to the model.
export interface BitarApiConfig { baseUrl: string; email: string; password: string }

const ALLOWED = [/^\/branches$/, /^\/reports\/(sales-summary|top-skus)$/, /^\/costs\/profit$/, /^\/stock$/, /^\/replenishment\/suggestions$/, /^\/transfers$/, /^\/cash-sessions$/, /^\/returns$/, /^\/settings$/];

export class BitarApiError extends Error {
    constructor(readonly status: number, message: string) { super(message); }
}

export class BitarApi {
    private token: string | null = null;
    private branchCache: { id: string; code: string; name: string; kind: string }[] | null = null;
    constructor(private readonly config: BitarApiConfig, private readonly fetcher: typeof fetch = fetch) {}

    private async login(): Promise<void> {
        const res = await this.fetcher(`${this.config.baseUrl}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: this.config.email, password: this.config.password }) });
        if (!res.ok) throw new BitarApiError(res.status, res.status === 401 ? 'The MCP account could not sign in: check BITAR_EMAIL and BITAR_PASSWORD' : `Sign-in failed (${res.status})`);
        this.token = ((await res.json()) as { token: string }).token;
    }

    // GET only. One retry after a fresh sign-in when the token has expired.
    async get<T = unknown>(path: string, query: Record<string, string | number | undefined> = {}): Promise<{ body: T; headers: Headers }> {
        if (!ALLOWED.some((rule) => rule.test(path))) throw new BitarApiError(403, `This tool cannot read ${path}`);
        const url = new URL(`${this.config.baseUrl}${path}`);
        for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
        for (let attempt = 0; attempt < 2; attempt++) {
            if (!this.token) await this.login();
            const res = await this.fetcher(url, { method: 'GET', headers: { Authorization: `Bearer ${this.token}` } });
            if (res.status === 401 && attempt === 0) { this.token = null; continue; }
            if (!res.ok) {
                const message = await res.json().then((b: { message?: string }) => b.message ?? '').catch(() => '');
                throw new BitarApiError(res.status, res.status === 403 ? `The MCP account is not allowed to read this (${message || 'forbidden'})` : message || `The API answered ${res.status}`);
            }
            return { body: (await res.json()) as T, headers: res.headers };
        }
        throw new BitarApiError(401, 'Not signed in');
    }

    async branches() {
        if (!this.branchCache) this.branchCache = (await this.get<{ id: string; code: string; name: string; kind: string }[]>('/branches')).body;
        return this.branchCache;
    }

    // a branch by the name or the code a person says ("Hamra", "hamra", "DEMO-HAM..."), or its id: one match or a clear error
    async resolveBranch(input: string): Promise<{ id: string; code: string; name: string; kind: string }> {
        const all = await this.branches();
        const wanted = input.trim().toLowerCase();
        const exact = all.filter((b) => b.id === input.trim() || b.code.toLowerCase() === wanted || b.name.toLowerCase() === wanted);
        const found = exact.length > 0 ? exact : all.filter((b) => b.name.toLowerCase().includes(wanted) || b.code.toLowerCase().includes(wanted));
        if (found.length === 1) return found[0];
        if (found.length === 0) throw new BitarApiError(404, `No branch matches "${input}". The branches are: ${all.map((b) => b.name).join(', ')}`);
        throw new BitarApiError(409, `"${input}" matches several branches: ${found.map((b) => b.name).join(', ')}. Say which one.`);
    }
}
