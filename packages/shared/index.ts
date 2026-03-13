export const API_VERSION = "1.0.0";

export interface HealthResponse {
  status: "ok";
  version: string;
  timestamp: string;
}

export interface Flag {
  id: number;
  key: string;
  name: string;
  enabled: boolean;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateFlagBody {
  key: string;
  name: string;
  enabled?: boolean;
  description?: string;
}

export interface UpdateFlagBody {
  name?: string;
  enabled?: boolean;
  description?: string;
}

export interface EvaluateResponse {
  key: string;
  enabled: boolean;
  evaluatedAt: string;
  source: "cache" | "database";
}

export type ErrorCode =
  | "FLAG_NOT_FOUND"
  | "FLAG_KEY_EXISTS"
  | "VALIDATION_ERROR"
  | "INTERNAL_ERROR"
  | "SERVICE_UNAVAILABLE"
  | "UNAUTHORIZED";

export interface AppError {
  code: ErrorCode;
  message: string;
  requestId: string;
}
