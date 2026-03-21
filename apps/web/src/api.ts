import posthog from "posthog-js";
import type { CreateFlagBody, EvaluateResponse, Flag, UpdateFlagBody } from "@project/shared";

// Guard: posthog.capture is a no-op when no key is configured (local dev, CI)
const analyticsEnabled = !!import.meta.env.VITE_POSTHOG_KEY;

const base = import.meta.env.VITE_API_URL || "http://localhost:3000";
const api = `${base}/api/v1`;
const apiKey = import.meta.env.VITE_API_KEY || "";

const headers = (): Record<string, string> => ({
  "Content-Type": "application/json",
  "X-Api-Key": apiKey,
});

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(err.message ?? `HTTP ${res.status}`);
  }

  return res.json() as Promise<T>;
}

export async function listFlags(): Promise<Flag[]> {
  const res = await fetch(`${api}/flags`, { headers: headers() });

  return handleResponse<Flag[]>(res);
}

export async function createFlag(body: CreateFlagBody): Promise<Flag> {
  const res = await fetch(`${api}/flags`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });

  return handleResponse<Flag>(res);
}

export async function updateFlag(key: string, body: UpdateFlagBody): Promise<Flag> {
  const res = await fetch(`${api}/flags/${key}`, {
    method: "PUT",
    headers: headers(),
    body: JSON.stringify(body),
  });

  const data = await handleResponse<Flag>(res);
  // Track toggle events — useful for funnel: flag_toggled → flag_evaluated → conversion
  if (analyticsEnabled && body.enabled !== undefined) {
    posthog.capture("flag_toggled", { flag_key: key, enabled: body.enabled });
  }

  return data;
}

export async function deleteFlag(key: string): Promise<void> {
  const res = await fetch(`${api}/flags/${key}`, {
    method: "DELETE",
    headers: headers(),
  });
  await handleResponse<unknown>(res);
}

export async function evaluateFlag(key: string): Promise<EvaluateResponse> {
  const res = await fetch(`${api}/evaluate/${key}`);
  const data = await handleResponse<EvaluateResponse>(res);

  // Track every flag evaluation: key, resolved value, and source (cache vs DB)
  if (analyticsEnabled) {
    posthog.capture("flag_evaluated", {
      flag_key: key,
      enabled: data.enabled,
      source: data.source,
    });
  }

  return data;
}
