import { and, desc, eq, ne } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";

import type {
  ConcludeExperimentBody,
  CreateExperimentBody,
  Experiment,
  ExperimentResultsResponse,
  ExperimentStatus,
  UpdateExperimentBody,
} from "@project/shared";
import { FlagKey } from "@project/shared";

import { diffChanges, hashActor, recordAudit } from "../audit.js";
import type { Cache } from "../cache.js";
import type { Db } from "../db.js";
import {
  experimentFlagConflict,
  experimentInvalidSplit,
  experimentInvalidState,
  experimentNotFound,
  flagNotFound,
} from "../errors.js";
import { canTransitionExperiment, isValidSplit } from "../experiments.js";
import { toExperimentResponse } from "../mappers.js";
import { registry } from "../metrics.js";
import { experiments, flags } from "../schema.js";
import { invalidateAllEnvCaches } from "./overrides.js";

declare module "fastify" {
  interface FastifyInstance {
    db: Db;
    cache: Cache | null;
  }
}

const createExperimentSchema = {
  body: {
    type: "object",
    required: ["flagKey", "name", "hypothesis", "primaryMetric"],
    additionalProperties: false,
    properties: {
      flagKey: { type: "string", minLength: 1, maxLength: 128, pattern: "^[a-z0-9_-]+$" },
      name: { type: "string", minLength: 1, maxLength: 200 },
      hypothesis: { type: "string", minLength: 1, maxLength: 2000 },
      primaryMetric: { type: "string", minLength: 1, maxLength: 100 },
      controlPercentage: { type: "integer", minimum: 0, maximum: 100 },
      variantPercentage: { type: "integer", minimum: 0, maximum: 100 },
      notes: { type: "string", maxLength: 4000 },
    },
  },
};

const updateExperimentSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    properties: {
      name: { type: "string", minLength: 1, maxLength: 200 },
      hypothesis: { type: "string", minLength: 1, maxLength: 2000 },
      primaryMetric: { type: "string", minLength: 1, maxLength: 100 },
      controlPercentage: { type: "integer", minimum: 0, maximum: 100 },
      variantPercentage: { type: "integer", minimum: 0, maximum: 100 },
      notes: { type: "string", maxLength: 4000 },
    },
  },
};

const concludeExperimentSchema = {
  body: {
    type: "object",
    required: ["conclusion"],
    additionalProperties: false,
    properties: {
      conclusion: { type: "string", enum: ["ship", "rollback", "inconclusive"] },
      notes: { type: "string", maxLength: 4000 },
    },
  },
};

function parseId(raw: string): number | null {
  const id = Number(raw);

  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Pull experiment cohort counters straight from the Prometheus registry.
 * We deliberately don't hit any time-series backend — `prom-client` keeps
 * an in-process counter which is exactly enough for a single-process lab.
 * In a multi-replica deployment this would need a scrape + PromQL query
 * against the Prometheus HTTP API instead.
 */
async function readCohortCounts(
  experimentId: number,
): Promise<{ control: number; variant: number; holdout: number }> {
  const counts = { control: 0, variant: 0, holdout: 0 };

  const metric = registry.getSingleMetric("experiment_evaluations_total");
  if (!metric) {
    return counts;
  }

  const snapshot = await metric.get();
  for (const v of snapshot.values) {
    const labels = v.labels as { experiment_id?: string; cohort?: string };
    if (Number(labels.experiment_id) !== experimentId) {
      continue;
    }

    if (labels.cohort === "control") {
      counts.control = v.value;
    }
    if (labels.cohort === "variant") {
      counts.variant = v.value;
    }
    if (labels.cohort === "holdout") {
      counts.holdout = v.value;
    }
  }

  return counts;
}

export const experimentsRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /experiments — create a new experiment in draft state
  fastify.post<{ Body: CreateExperimentBody; Reply: Experiment }>(
    "/",
    { schema: createExperimentSchema },
    async (request, reply) => {
      const body = request.body;
      const controlPct = body.controlPercentage ?? 50;
      const variantPct = body.variantPercentage ?? 50;

      if (!isValidSplit(controlPct, variantPct)) {
        throw experimentInvalidSplit();
      }

      // Flag must exist (FK would catch this at insert, but a typed error is nicer)
      const flag = await fastify.db.query.flags.findFirst({
        where: eq(flags.key, body.flagKey),
      });

      if (!flag) {
        throw flagNotFound(body.flagKey);
      }

      const [row] = await fastify.db
        .insert(experiments)
        .values({
          flagKey: body.flagKey,
          name: body.name,
          hypothesis: body.hypothesis,
          primaryMetric: body.primaryMetric,
          controlPercentage: controlPct,
          variantPercentage: variantPct,
          notes: body.notes ?? null,
        })
        .returning();

      const apiKey = request.headers["x-api-key"] as string;
      void recordAudit(
        fastify.db,
        {
          entityType: "experiment",
          entityKey: String(row.id),
          action: "created",
          actor: hashActor(apiKey),
          changes: diffChanges(
            {},
            {
              flagKey: row.flagKey,
              name: row.name,
              hypothesis: row.hypothesis,
              primaryMetric: row.primaryMetric,
              controlPercentage: row.controlPercentage,
              variantPercentage: row.variantPercentage,
            },
          ),
          metadata: { flagKey: row.flagKey },
        },
        request.log,
      );

      return reply.status(201).send(toExperimentResponse(row));
    },
  );

  // GET /experiments — list all experiments, newest first
  fastify.get<{
    Querystring: { status?: ExperimentStatus; flagKey?: string };
    Reply: Experiment[];
  }>(
    "/",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            status: { type: "string", enum: ["draft", "running", "concluded"] },
            flagKey: { type: "string", minLength: 1, maxLength: 128 },
          },
        },
      },
    },
    async (request) => {
      const conditions = [];
      if (request.query.status) {
        conditions.push(eq(experiments.status, request.query.status));
      }
      if (request.query.flagKey) {
        conditions.push(eq(experiments.flagKey, request.query.flagKey));
      }

      const rows = await fastify.db
        .select()
        .from(experiments)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(experiments.createdAt));

      return rows.map(toExperimentResponse);
    },
  );

  // GET /experiments/:id — single experiment
  fastify.get<{ Params: { id: string }; Reply: Experiment }>("/:id", async (request) => {
    const id = parseId(request.params.id);
    if (!id) throw experimentNotFound(0);

    const row = await fastify.db.query.experiments.findFirst({
      where: eq(experiments.id, id),
    });
    if (!row) throw experimentNotFound(id);

    return toExperimentResponse(row);
  });

  // PUT /experiments/:id — update (draft only)
  fastify.put<{ Params: { id: string }; Body: UpdateExperimentBody; Reply: Experiment }>(
    "/:id",
    { schema: updateExperimentSchema },
    async (request) => {
      const id = parseId(request.params.id);
      if (!id) throw experimentNotFound(0);

      const existing = await fastify.db.query.experiments.findFirst({
        where: eq(experiments.id, id),
      });
      if (!existing) throw experimentNotFound(id);

      // Only draft experiments are mutable — running/concluded are frozen
      if (existing.status !== "draft") {
        throw experimentInvalidState(existing.status, "draft");
      }

      const controlPct = request.body.controlPercentage ?? existing.controlPercentage;
      const variantPct = request.body.variantPercentage ?? existing.variantPercentage;

      if (!isValidSplit(controlPct, variantPct)) {
        throw experimentInvalidSplit();
      }

      const updates: Partial<typeof experiments.$inferInsert> = {
        updatedAt: new Date(),
      };

      if (request.body.name !== undefined) updates.name = request.body.name;
      if (request.body.hypothesis !== undefined) updates.hypothesis = request.body.hypothesis;
      if (request.body.primaryMetric !== undefined) {
        updates.primaryMetric = request.body.primaryMetric;
      }
      if (request.body.controlPercentage !== undefined) {
        updates.controlPercentage = request.body.controlPercentage;
      }
      if (request.body.variantPercentage !== undefined) {
        updates.variantPercentage = request.body.variantPercentage;
      }
      if (request.body.notes !== undefined) updates.notes = request.body.notes;

      const before = {
        name: existing.name,
        hypothesis: existing.hypothesis,
        primaryMetric: existing.primaryMetric,
        controlPercentage: existing.controlPercentage,
        variantPercentage: existing.variantPercentage,
        notes: existing.notes,
      };

      const [row] = await fastify.db
        .update(experiments)
        .set(updates)
        .where(eq(experiments.id, id))
        .returning();

      const after = {
        name: row.name,
        hypothesis: row.hypothesis,
        primaryMetric: row.primaryMetric,
        controlPercentage: row.controlPercentage,
        variantPercentage: row.variantPercentage,
        notes: row.notes,
      };
      const changes = diffChanges(before, after);

      if (Object.keys(changes).length > 0) {
        const apiKey = request.headers["x-api-key"] as string;
        void recordAudit(
          fastify.db,
          {
            entityType: "experiment",
            entityKey: String(row.id),
            action: "updated",
            actor: hashActor(apiKey),
            changes,
            metadata: { flagKey: row.flagKey },
          },
          request.log,
        );
      }

      return toExperimentResponse(row);
    },
  );

  // POST /experiments/:id/start — draft → running
  fastify.post<{ Params: { id: string }; Reply: Experiment }>(
    "/:id/start",
    async (request, reply) => {
      const id = parseId(request.params.id);
      if (!id) throw experimentNotFound(0);

      const existing = await fastify.db.query.experiments.findFirst({
        where: eq(experiments.id, id),
      });
      if (!existing) throw experimentNotFound(id);

      if (!canTransitionExperiment(existing.status as ExperimentStatus, "running")) {
        throw experimentInvalidState(existing.status, "running");
      }

      // Invariant: only one running experiment per flag.
      // Non-atomic check — acceptable in the learning scope; a production
      // system would enforce this with a partial unique index or advisory lock.
      const conflict = await fastify.db.query.experiments.findFirst({
        where: and(
          eq(experiments.flagKey, existing.flagKey),
          eq(experiments.status, "running"),
          ne(experiments.id, existing.id),
        ),
      });
      if (conflict) {
        throw experimentFlagConflict(existing.flagKey);
      }

      const startDate = new Date();

      // Update experiment to running + sync flag rollout to the variant share.
      // Running experiments take over targeting; the variant percentage acts
      // as the effective rollout for the flag's default config.
      const [row] = await fastify.db
        .update(experiments)
        .set({
          status: "running",
          startDate,
          updatedAt: startDate,
        })
        .where(eq(experiments.id, id))
        .returning();

      // Sync the flag: enable it so the experiment can serve evaluations,
      // and set rollout to variant% for consistency with non-experiment callers.
      await fastify.db
        .update(flags)
        .set({
          enabled: true,
          rolloutPercentage: row.variantPercentage,
          updatedAt: startDate,
        })
        .where(eq(flags.key, row.flagKey));

      // Cache invalidation — flag default changed
      await invalidateAllEnvCaches(fastify.cache, row.flagKey, fastify.log);

      const apiKey = request.headers["x-api-key"] as string;
      void recordAudit(
        fastify.db,
        {
          entityType: "experiment",
          entityKey: String(row.id),
          action: "updated",
          actor: hashActor(apiKey),
          changes: {
            status: { from: "draft", to: "running" },
            startDate: { from: null, to: startDate.toISOString() },
          },
          metadata: { flagKey: row.flagKey, transition: "start" },
        },
        request.log,
      );

      return reply.status(200).send(toExperimentResponse(row));
    },
  );

  // POST /experiments/:id/conclude — running → concluded
  fastify.post<{
    Params: { id: string };
    Body: ConcludeExperimentBody;
    Reply: Experiment;
  }>("/:id/conclude", { schema: concludeExperimentSchema }, async (request, reply) => {
    const id = parseId(request.params.id);
    if (!id) throw experimentNotFound(0);

    const existing = await fastify.db.query.experiments.findFirst({
      where: eq(experiments.id, id),
    });
    if (!existing) throw experimentNotFound(id);

    if (!canTransitionExperiment(existing.status as ExperimentStatus, "concluded")) {
      throw experimentInvalidState(existing.status, "concluded");
    }

    const endDate = new Date();
    const mergedNotes =
      request.body.notes !== undefined
        ? [existing.notes, request.body.notes].filter(Boolean).join("\n---\n")
        : existing.notes;

    const [row] = await fastify.db
      .update(experiments)
      .set({
        status: "concluded",
        endDate,
        conclusion: request.body.conclusion,
        notes: mergedNotes,
        updatedAt: endDate,
      })
      .where(eq(experiments.id, id))
      .returning();

    // Decision-driven flag sync:
    //   ship     → flag stays enabled at 100% (full rollout)
    //   rollback → flag disabled
    //   inconclusive → leave flag as-is (operator decides manually)
    if (request.body.conclusion === "ship") {
      await fastify.db
        .update(flags)
        .set({ enabled: true, rolloutPercentage: 100, updatedAt: endDate })
        .where(eq(flags.key, row.flagKey));
      await invalidateAllEnvCaches(fastify.cache, row.flagKey, fastify.log);
    } else if (request.body.conclusion === "rollback") {
      await fastify.db
        .update(flags)
        .set({ enabled: false, updatedAt: endDate })
        .where(eq(flags.key, row.flagKey));
      await invalidateAllEnvCaches(fastify.cache, row.flagKey, fastify.log);
    }

    const apiKey = request.headers["x-api-key"] as string;
    void recordAudit(
      fastify.db,
      {
        entityType: "experiment",
        entityKey: String(row.id),
        action: "updated",
        actor: hashActor(apiKey),
        changes: {
          status: { from: "running", to: "concluded" },
          conclusion: { from: null, to: request.body.conclusion },
          endDate: { from: null, to: endDate.toISOString() },
        },
        metadata: { flagKey: row.flagKey, transition: "conclude" },
      },
      request.log,
    );

    return reply.status(200).send(toExperimentResponse(row));
  });

  // GET /experiments/:id/results — aggregated cohort data from Prometheus
  fastify.get<{ Params: { id: string }; Reply: ExperimentResultsResponse }>(
    "/:id/results",
    async (request) => {
      const id = parseId(request.params.id);
      if (!id) throw experimentNotFound(0);

      const row = await fastify.db.query.experiments.findFirst({
        where: eq(experiments.id, id),
      });
      if (!row) throw experimentNotFound(id);

      const counts = await readCohortCounts(id);

      const durationHours = row.startDate
        ? ((row.endDate ?? new Date()).getTime() - row.startDate.getTime()) / (1000 * 60 * 60)
        : null;

      return {
        experimentId: row.id,
        flagKey: FlagKey(row.flagKey),
        status: row.status as ExperimentStatus,
        control: { evaluations: counts.control },
        variant: { evaluations: counts.variant },
        holdout: { evaluations: counts.holdout },
        durationHours,
      };
    },
  );
};
