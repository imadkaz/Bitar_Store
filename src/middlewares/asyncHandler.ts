// From: src/middleware/asyncHandler.ts
import { NextFunction, Request, Response } from "express";

// Wraps an async function and catches any rejected promises, passing the error to next()
export const asyncHandler = (fn : (req: Request, res: Response) => Promise<void>) => {
    return (req: Request, res: Response, next: NextFunction) =>
        fn(req, res).catch(next);
};