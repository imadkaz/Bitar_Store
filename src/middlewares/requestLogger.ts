import { NextFunction, Request, Response } from 'express';
import logger from '../utils/logger';

const requestLogger = (req: Request, res: Response, next: NextFunction) => {
    const startTime = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - startTime;
        const status = res.statusCode;
        const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
        logger.log({level, message: `${req.method} ${req.originalUrl} ${status} ${duration}ms`});
             
    });
    next();
}

export default requestLogger;