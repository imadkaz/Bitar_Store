import cors from 'cors';

// CORS = the browser asking the server: "this page came from ANOTHER address (e.g. http://localhost:3001),
// are you OK with it calling you?". The server answers with headers. Postman and curl never ask, only browsers do.
export function createCors() {
    // CORS_ORIGIN in .env, several origins separated by commas. Each must match EXACTLY:
    // scheme + host + port, no trailing slash. Example: http://localhost:3001,https://app.bitar.com
    const allowedOrigins = (process.env.CORS_ORIGIN ?? 'http://localhost:3001')
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean);

    return cors({
        origin: allowedOrigins,
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        // Every NON-standard header the frontend sends must be listed here, or the browser blocks the request.
        allowedHeaders: ['Content-Type', 'Authorization', 'X-User-Id', 'Idempotency-Key'],
        maxAge: 600,   // the browser may remember the answer for 10 minutes (fewer preflight requests)
    });
}