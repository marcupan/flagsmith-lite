import { createError, type ErrorCode } from "@project/shared";

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

/** Create an AppError from a shared ErrorCode definition. */
export function appError(code: ErrorCode, overrideMessage?: string): AppError {
  const def = createError(code, overrideMessage);

  return new AppError(code, def.message, def.status);
}

export const flagNotFound = (key: string) => appError("FLAG_NOT_FOUND", `Flag "${key}" not found`);

export const flagKeyExists = (key: string) =>
  appError("FLAG_KEY_EXISTS", `Flag with key "${key}" already exists`);

export const webhookNotFound = (id: number) =>
  appError("WEBHOOK_NOT_FOUND", `Webhook subscription ${id} not found`);

export const webhookInvalidUrl = (url: string) =>
  appError("WEBHOOK_INVALID_URL", `Invalid webhook URL: ${url}`);

export const webhookInvalidEvents = () =>
  appError("WEBHOOK_INVALID_EVENTS", "Events must contain only valid webhook event types");
