
import express from "express";
import cors from "cors";
import helmet from "helmet";
import "dotenv/config";
import logger from "./utils/logger";
import config from "./config";
import { Request, Response, NextFunction } from "express";
import { ConflictError } from "./utils/exeptions/ConflictError";
import { NotFoundError } from "./utils/exeptions/NotFoundError";
import { ValidationError } from "./utils/exeptions/ValidationError";
import { HttpException } from "./utils/exeptions/httpException";
import requestLogger from "./middlewares/requestLogger";

const app = express();

app.use(helmet());

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());


app.use(requestLogger);

app.use((req, res) => {
    res.status(404).json({ message: 'Resource not found' });
});


app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    if (err instanceof NotFoundError) {
        return res.status(404).json({ message: err.message });
    }
    if (err instanceof ConflictError) {
        return res.status(409).json({ message: err.message });
    }
    if (err instanceof ValidationError) {
        return res.status(400).json({ message: err.message });
    }
    if (err instanceof HttpException) {
        return res.status(err.status).json({
            message: err.message,
            details: err.details,
        });
    }

    logger.error('Unhandled Error: %s', err.message);
    return next(err);
});

app.listen(config.port, config.host, () => {
    logger.info(`Server is running on port ${config.port}`);
});
