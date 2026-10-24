import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.join(__dirname, "../../.env") });

export default {
    secret : process.env.secret || "default_secret_key",
    NODE_ENV: process.env.NODE_ENV || 'development', // Checks if the environment type (e.g., 'production' or 'development') is set; if not, it uses 'development' as default.
    logDir: 'logs',
    port: process.env.PORT ? parseInt(process.env.PORT) : 3000, // Sets the port for the application; defaults to 3000 if not specified in the environment variables.
    host: process.env.HOST || 'localhost', // Sets the host for the application; defaults to 'localhost' if not specified in the environment variables.
}