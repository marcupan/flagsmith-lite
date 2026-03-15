import type { ErrorCode } from "@project/shared";

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly statusCode: number = 500,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function flagNotFound(key: string): AppError {
  return new AppError("FLAG_NOT_FOUND", `Flag "${key}" not found`, 404);
}

export function flagKeyExists(key: string): AppError {
  return new AppError("FLAG_KEY_EXISTS", `Flag with key "${key}" already exists`, 409);
}
