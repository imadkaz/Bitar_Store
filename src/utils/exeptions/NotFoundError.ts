import { HttpException } from "./httpException";

// src/exceptions/NotFoundError.ts
export class NotFoundError extends HttpException {
    constructor(message: string) {
        super(404, message);
    }
}