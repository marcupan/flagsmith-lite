# API Reference

Base URL: `http://localhost:3000`

## Authentication

Protected endpoints require `X-Api-Key` header:

```
X-Api-Key: your-api-key
```

Missing or invalid key returns `401 UNAUTHORIZED`.

## Rate Limiting

| Scope                       | Limit        | Window   |
| --------------------------- | ------------ | -------- |
| Global (all endpoints)      | 100 requests | 1 minute |
| `GET /api/v1/evaluate/:key` | 60 requests  | 1 minute |

Exceeded limits return `429` with `RATE_LIMIT_EXCEEDED` code and `Retry-After` header.

---

## Endpoints

### Health Check

```
GET /health
```

Public. Not versioned — infrastructure endpoint.

```bash
curl -s http://localhost:3000/health | jq .
```

```json
{
  "status": "ok",
  "version": "1.0.0",
  "timestamp": "2026-03-21T12:00:00.000Z"
}
```

---

### List Flags

```
GET /api/v1/flags
```

Auth: required. Returns all flags sorted by creation time (newest first).

```bash
curl -s http://localhost:3000/api/v1/flags \
  -H "X-Api-Key: $API_KEY" | jq .
```

```json
[
  {
    "id": 1,
    "key": "dark-mode",
    "name": "Dark Mode",
    "enabled": true,
    "description": null,
    "createdAt": "2026-03-21T12:00:00.000Z",
    "updatedAt": "2026-03-21T12:00:00.000Z"
  }
]
```

---

### Create Flag

```
POST /api/v1/flags
```

Auth: required.

| Field         | Type    | Required | Constraints                  |
| ------------- | ------- | -------- | ---------------------------- |
| `key`         | string  | Yes      | `^[a-z0-9_-]+$`, 1-128 chars |
| `name`        | string  | Yes      | 1-256 chars                  |
| `enabled`     | boolean | No       | Defaults to `false`          |
| `description` | string  | No       | Max 1024 chars               |

```bash
curl -s -X POST http://localhost:3000/api/v1/flags \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $API_KEY" \
  -d '{"key":"dark-mode","name":"Dark Mode"}' | jq .
```

Returns `201` with created flag. Returns `409 FLAG_KEY_EXISTS` if key is taken.

---

### Get Flag

```
GET /api/v1/flags/:key
```

Auth: required.

```bash
curl -s http://localhost:3000/api/v1/flags/dark-mode \
  -H "X-Api-Key: $API_KEY" | jq .
```

Returns `404 FLAG_NOT_FOUND` if key doesn't exist.

---

### Update Flag

```
PUT /api/v1/flags/:key
```

Auth: required. All fields optional. Invalidates cache on success.

| Field         | Type    | Constraints    |
| ------------- | ------- | -------------- |
| `name`        | string  | 1-256 chars    |
| `enabled`     | boolean | —              |
| `description` | string  | Max 1024 chars |

```bash
curl -s -X PUT http://localhost:3000/api/v1/flags/dark-mode \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $API_KEY" \
  -d '{"enabled":true}' | jq .
```

Returns `404 FLAG_NOT_FOUND` if key doesn't exist.

---

### Delete Flag

```
DELETE /api/v1/flags/:key
```

Auth: required. Invalidates cache on success.

```bash
curl -s -X DELETE http://localhost:3000/api/v1/flags/dark-mode \
  -H "X-Api-Key: $API_KEY" | jq .
```

```json
{ "deleted": true }
```

Returns `404 FLAG_NOT_FOUND` if key doesn't exist.

---

### Evaluate Flag

```
GET /api/v1/evaluate/:key
```

Auth: **not required** (public endpoint for SDK consumers). Rate-limited to 60 req/min.

**Cache behavior:** Redis cache with 30s TTL. Response `source` field indicates `"cache"` or `"database"`. Cache misses are populated automatically. If Redis is unavailable, falls back to database silently.

```bash
curl -s http://localhost:3000/api/v1/evaluate/dark-mode | jq .
```

```json
{
  "key": "dark-mode",
  "enabled": true,
  "evaluatedAt": "2026-03-21T12:00:00.000Z",
  "source": "database"
}
```

Returns `404 FLAG_NOT_FOUND` if key doesn't exist.

---

## Error Responses

All errors follow the same shape:

```json
{
  "code": "FLAG_NOT_FOUND",
  "message": "Flag \"dark-mode\" not found",
  "requestId": "550e8400-e29b-41d4-a716-446655440000"
}
```

| Code                  | Status | When                                    |
| --------------------- | ------ | --------------------------------------- |
| `FLAG_NOT_FOUND`      | 404    | GET/PUT/DELETE with unknown key         |
| `FLAG_KEY_EXISTS`     | 409    | POST with duplicate key                 |
| `VALIDATION_ERROR`    | 400    | Invalid request body (schema violation) |
| `UNAUTHORIZED`        | 401    | Missing or invalid `X-Api-Key` header   |
| `RATE_LIMIT_EXCEEDED` | 429    | Too many requests                       |
| `INTERNAL_ERROR`      | 500    | Unhandled server error                  |
| `SERVICE_UNAVAILABLE` | 503    | Database unavailable                    |

Every response includes `x-request-id` header for tracing. Pass your own via `X-Request-Id` request header (UUID or alphanumeric slug, max 64 chars).

---

## Type Definitions

All request/response types are defined in [`packages/shared/index.ts`](../packages/shared/index.ts) and shared between API, web UI, and SDK consumers.
