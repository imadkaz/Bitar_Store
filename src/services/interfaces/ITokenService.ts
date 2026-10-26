export interface ITokenService {
    sign(userId: string): string;
    verify(token: string): string;   // returns the user id, or throws UnauthorizedError
}
