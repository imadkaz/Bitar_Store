import express from "express";
import helmet from "helmet";
import "dotenv/config";
import logger from "./utils/logger";
import { Request, Response, NextFunction } from "express";
import { ConflictError } from "./utils/exeptions/ConflictError";
import { ForbiddenError } from "./utils/exeptions/ForbiddenError";
import { NotFoundError } from "./utils/exeptions/NotFoundError";
import { UnauthorizedError } from "./utils/exeptions/UnauthorizedError";
import { ValidationError } from "./utils/exeptions/ValidationError";
import { HttpException } from "./utils/exeptions/httpException";
import requestLogger from "./middlewares/requestLogger";
import { routes } from "./routes";
import { createCors } from "./middlewares/cors";
import { InsufficientStockError } from "./utils/exeptions/InsufficientStockError";

export const app = express();

app.use(helmet());
app.use(createCors());
app.use(express.json());
app.use(requestLogger);

app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
});

app.use('/', routes);                                   // 1) the real routes first

app.use((_req, res) => {                                // 2) nothing matched: 404
    res.status(404).json({ message: 'Resource not found' });
});

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {   // 3) errors, last (keep 4 parameters)
    if (err instanceof UnauthorizedError) return res.status(401).json({ message: err.message });
    if (err instanceof ForbiddenError) return res.status(403).json({ message: err.message });
    if (err instanceof NotFoundError) return res.status(404).json({ message: err.message });
        if (err instanceof InsufficientStockError) {
        return res.status(409).json({ message: err.message, details: err.shortages });   // the API still answers with "details"
    }
    if (err instanceof ConflictError) return res.status(409).json({ message: err.message });
    if (err instanceof ValidationError) return res.status(400).json({ message: err.message });
    if (err instanceof HttpException) {
        return res.status(err.status).json({ message: err.message, details: err.details });
    }
    if ((err as { type?: string }).type === 'entity.parse.failed') {
        return res.status(400).json({ message: 'Invalid JSON body' });
    }

    logger.error('Unhandled Error: %s', err.message);
    return res.status(500).json({ message: 'Internal Server Error' });
});

