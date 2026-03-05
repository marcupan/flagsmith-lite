export const API_VERSION = "1.0.0";

export interface HealthResponse {
    status: "ok";
    version: string;
    timestamp: string;
}
