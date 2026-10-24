import { HttpException } from "./httpException";

// src/exceptions/ConflictError.ts
export class ConflictError extends HttpException {
    constructor(message: string) {
        super(409, message);
    }
}
