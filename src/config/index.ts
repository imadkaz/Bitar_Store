import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.join(__dirname, "../../.env") });

const jwtSecret = process.env.JWT_SECRET ?? '';
if (jwtSecret.length < 32) {
    throw new Error('JWT_SECRET must be set in .env and be at least 32 characters');
}

// 'jwt' = real login tokens. 'dev' = ALSO accept the X-User-Id header (development only).
const authMode: 'jwt' | 'dev' = process.env.AUTH_MODE === 'dev' ? 'dev' : 'jwt';
if (process.env.NODE_ENV === 'production' && authMode === 'dev') {
    throw new Error('AUTH_MODE=dev must never run in production');
}

export default {
    secret : process.env.secret || "default_secret_key",
    NODE_ENV: process.env.NODE_ENV || 'development', // Checks if the environment type (e.g., 'production' or 'development') is set; if not, it uses 'development' as default.
    logDir: 'logs',
    port: process.env.PORT ? parseInt(process.env.PORT) : 3000, // Sets the port for the application; defaults to 3000 if not specified in the environment variables.
    host: process.env.HOST || 'localhost', // Sets the host for the application; defaults to 'localhost' if not specified in the environment variables.
    jwtSecret: jwtSecret, // The secret key used for signing JWT tokens; must be at least 32 characters long.
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '8h', // The expiration time for JWT tokens; defaults to 8 hours if not specified in the environment variables.
    authMode: authMode, // The authentication mode; can be either 'jwt' or 'dev'.
}