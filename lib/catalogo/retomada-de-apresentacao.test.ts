import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

import type { ChannelAdapter, ChannelSendInput } from "@/lib/agent-engine/channel-adapter";
import type { runBeforeSend } from "@/lib/agent-engine/guardrails/before-send";
import type { reconcileAcceptedSend } from "@/lib/agent-engine/edge/crm/send-ledger";
import type { JobRow } from "@/lib/agent-engine/queue/queue";
import { planCatalogPresentation } from "@/lib/catalogo/plano-de-apresentacao";
import { prepareCatalogPresentationPayloads } from "@/lib/catalogo/preparo-de-apresentacao";
import {
  CatalogPresentationResumeError,
  resumePersistedCatalogPresentation,
} from "@/lib/catalogo/retomada-de-apresentacao";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const CONTACT = "bbbbbbbb-0000-4000-8000-000000000001";
const JOB = "cccccccc-0000-4000-8000-000000000001";
const CONVERSATION = "dddddddd-0000-4000-8000-000000000001";
const OPERATION = { organizationId: ORG, agentId:"99999999-0000-4000-8000-000000000001",versionId:"99999999-0000-4000-8000-000000000002",revision:"3" };
const SESSION = "eeeeeeee-0000-4000-8000-000000000001";

function snapshot(offset = 0) {
  const planned = planCatalogPresentation({
    ordered_product_codes: ["A", "B"],
    resolved_items: ["A", "B"].map((code, index) => ({
      product_id: `ffffffff-0000-4000-8000-00000000000${index + 1}`,
      product_code: code,
      product_name: `Produto ${code}`,
      price_cents: 1000,
      currency: "BRL",
      photo_storage_paths: [],
      presentation: {
        enabled: true,
        kind: "text" as const,
        title: null,
        text_content: `Texto ${code}`,
        use_catalog_photos: false,
        show_price: false,
        audio_storage_path: null,
        audio_mime: null,
      },
    })),
  });
  if (!planned.ok) throw new Error(planned.error.code);
  return {
    schema_version: 1 as const,
    sends_already_counted: offset,
    ordered_product_codes: ["A", "B"],
    plan: planned.plan,
    agent_operation: OPERATION,
  };
}

function job(offset = 0): JobRow {
  return {
    id: JOB,
    organization_id: ORG,
    contact_id: CONTACT,
    kind: "inbound_turn",
    source_event_id: null,
    payload: {},
    catalog_presentation_snapshot: snapshot(offset),
    status: "running",
    priority: 100,
    run_after: new Date(),
    attempts: 1,
    max_attempts: 5,
    last_error: null,
    locked_by: "worker-a",
    locked_at: new Date("2026-10-15T12:00:00.000Z"),
    claim_acquired_at: "2026-10-15T12:00:00.000Z",
    created_at: new Date(),
  };
}

function fixture(
  options: { outcomes?: string[]; reconciled?: number[]; dispositionFound?: boolean } = {},
) {
  const sql: string[] = [];
  const pool = {
    async query(text: string) {
      sql.push(text);
      if (text.includes("as current")) return {rows:[{current:true}],rowCount:1};
      if (text.includes("from ai_agents")) return {rows:[{published_version_id:OPERATION.versionId,operation_revision:OPERATION.revision,operation_mode:"automatic",paused_at:null,archived_at:null}],rowCount:1};
      if (text.includes("select source, consent, is_anonymized")) {
        return {
          rows: [{ source: "whatsapp", consent: {}, is_anonymized: false }],
          rowCount: 1,
        };
      }
      if (text.includes("update job_queue")) {
        return options.dispositionFound === false
          ? { rows: [], rowCount: 0 }
          : { rows: [job()], rowCount: 1 };
      }
      throw new Error(`consulta inesperada: ${text}`);
    },
  } as unknown as Pool;
  const sent: ChannelSendInput[] = [];
  let outcomeIndex = 0;
  const channel: ChannelAdapter = {
    channel: "test",
    async send(input) {
      sent.push(input);
      const kind = options.outcomes?.[outcomeIndex++] ?? "sent";
      if (kind === "unavailable") return { kind, reason: "test" };
      if (kind === "blocked") return { kind, idempotencyKey: `key-${input.seq}` };
      return {
        kind: kind as "sent" | "queued" | "failed" | "already_sent",
        idempotencyKey: `key-${input.seq}`,
        messageId: `message-${input.seq}`,
      };
    },
    async sessionHealth() {
      return { healthy: true, status: "WORKING", since: null };
    },
    capabilities() {
      return { freeformAnytime: true, serviceWindowHours: null };
    },
    costPerMessage() {
      return { perMessageUsdCents: 0, model: "flat" };
    },
  };
  const beforeSend = vi.fn(async (args: Parameters<typeof runBeforeSend>[0]) => ({
    status: "sent" as const,
    outcome: await args.send(args.body),
    trace: [],
  })) as unknown as typeof runBeforeSend;
  const reconcileMock = vi.fn(async (_pool: unknown, input: { seq: number }) =>
    (options.reconciled ?? []).includes(input.seq),
  );
  const reconcile = reconcileMock as unknown as typeof reconcileAcceptedSend;
  const materialize = vi.fn(async (persisted: { snapshot: ReturnType<typeof snapshot> }) => {
    const prepared = prepareCatalogPresentationPayloads(persisted.snapshot.plan);
    if (!prepared.ok) throw new Error(prepared.error.code);
    return {
      ok: true as const,
      materialized: {
        physical_payload_count: prepared.prepared.physical_payload_count,
        payloads: prepared.prepared.payloads.map((payload) => ({ payload })),
      },
    };
  });
  return { pool, sql, sent, channel, beforeSend, reconcile, reconcileMock, materialize };
}

function deps(
  f: ReturnType<typeof fixture>,
  interruptedBetweenItems = async () => false,
  agentPaused = async () => false,
) {
  return {
    channel: f.channel,
    log: {} as never,
    maxSendsPerTurn: 10,
    queuedRetryDelayMs: 30_000,
    respostaObsoletaTetoMs: 5_000,
    contracts: {
      beforeSend: f.beforeSend,
      reconcileAcceptedSend: f.reconcile,
      materialize: f.materialize as never,
      interruptedBeforeFirstItem: async () => false,
      interruptedBetweenItems,
      agentPaused,
    },
  };
}

describe("retomada da apresentacao persistida pelo worker", () => {
  it("retoma na seq congelada, em ordem, passando por ledger e guardrail", async () => {
    const f = fixture({ reconciled: [3] });

    const result = await resumePersistedCatalogPresentation(
      f.pool,
      job(2),
      { workerId: "worker-a" },
      { conversationId: CONVERSATION, channelSessionId: SESSION },
      deps(f),
    );

    expect(result).toEqual({ handled: true, disposition: "completed" });
    expect(f.reconcileMock.mock.calls.map((call) => call[1].seq)).toEqual([3, 4]);
    expect(f.sent.map((input) => [input.seq, input.body])).toEqual([[4, "Produto B\n\nTexto B"]]);
    expect(f.beforeSend).toHaveBeenCalledTimes(1);
  });

  it("queued devolve o mesmo job a pending sem consumir tentativa", async () => {
    const f = fixture({ outcomes: ["queued"] });

    const result = await resumePersistedCatalogPresentation(
      f.pool,
      job(),
      { workerId: "worker-a" },
      { conversationId: CONVERSATION, channelSessionId: SESSION },
      deps(f),
    );

    expect(result).toEqual({ handled: true, disposition: "settled" });
    const reschedule = f.sql.find((text) => text.includes("attempts = greatest(attempts - 1, 0)"));
    expect(reschedule).toContain("status = 'pending'");
    expect(f.sent.map((input) => input.seq)).toEqual([1]);
  });

  it("nao registra queued como settled quando o lease foi perdido", async () => {
    const f = fixture({ outcomes: ["queued"], dispositionFound: false });

    await expect(
      resumePersistedCatalogPresentation(
        f.pool,
        job(),
        { workerId: "worker-a" },
        { conversationId: CONVERSATION, channelSessionId: SESSION },
        deps(f),
      ),
    ).rejects.toThrowError("catalog_presentation_job_lease_lost");
    expect(f.sent.map((input) => input.seq)).toEqual([1]);
  });

  it("nao registra pacing como settled quando o lease foi perdido ao reagendar", async () => {
    const f = fixture({ dispositionFound: false });
    f.beforeSend = vi.fn(async () => ({
      status: "vetoed" as const,
      gate: "pacing",
      code: "pacing_limit",
      message: "aguarde antes de enviar",
      nextAllowedAt: new Date("2026-10-15T12:01:00.000Z"),
      trace: [],
    })) as unknown as typeof runBeforeSend;

    await expect(
      resumePersistedCatalogPresentation(
        f.pool,
        job(),
        { workerId: "worker-a" },
        { conversationId: CONVERSATION, channelSessionId: SESSION },
        { ...deps(f), clock: () => new Date("2026-10-15T12:00:00.000Z") },
      ),
    ).rejects.toThrowError("catalog_presentation_job_lease_lost");
    expect(f.sql.some((text) => text.includes("status = 'pending'"))).toBe(true);
  });

  it("nao registra cancelamento LGPD como settled quando o lease foi perdido", async () => {
    const f = fixture({ dispositionFound: false });
    f.beforeSend = vi.fn(async () => ({
      status: "vetoed" as const,
      gate: "lgpd",
      code: "lgpd_missing_legal_basis",
      message: "base legal ausente",
      trace: [],
    })) as unknown as typeof runBeforeSend;

    await expect(
      resumePersistedCatalogPresentation(
        f.pool,
        job(),
        { workerId: "worker-a" },
        { conversationId: CONVERSATION, channelSessionId: SESSION },
        deps(f),
      ),
    ).rejects.toThrowError("catalog_presentation_job_lease_lost");
    expect(f.sql.some((text) => text.includes("status = 'failed'"))).toBe(true);
  });

  it("interrompe apenas entre itens e nao inicia o seguinte", async () => {
    const f = fixture();

    const result = await resumePersistedCatalogPresentation(
      f.pool,
      job(),
      { workerId: "worker-a" },
      { conversationId: CONVERSATION, channelSessionId: SESSION },
      deps(f, async () => true),
    );

    expect(result).toEqual({ handled: true, disposition: "interrupted" });
    expect(f.sent.map((input) => input.body)).toEqual(["Produto A\n\nTexto A"]);
  });

  it("pausa apos o primeiro produto: reagenda o mesmo job e retoma sem duplicar a seq", async () => {
    const reconciled: number[] = [];
    const f = fixture({ reconciled });
    let paused = false;
    const originalSend = f.channel.send.bind(f.channel);
    f.channel.send = async (input) => {
      const outcome = await originalSend(input);
      paused = true;
      return outcome;
    };
    const resumeDeps = deps(
      f,
      async () => false,
      async () => paused,
    );
    const persisted = job();

    expect(
      await resumePersistedCatalogPresentation(
        f.pool,
        persisted,
        { workerId: "worker-a" },
        { conversationId: CONVERSATION, channelSessionId: SESSION },
        resumeDeps,
      ),
    ).toEqual({ handled: true, disposition: "settled" });
    expect(f.sent.map((input) => input.seq)).toEqual([1]);
    expect(f.sql.some((text) => text.includes("attempts = greatest(attempts - 1, 0)"))).toBe(true);
    expect(persisted.catalog_presentation_snapshot).toEqual(snapshot());

    paused = false;
    reconciled.push(1);
    expect(
      await resumePersistedCatalogPresentation(
        f.pool,
        persisted,
        { workerId: "worker-a" },
        { conversationId: CONVERSATION, channelSessionId: SESSION },
        resumeDeps,
      ),
    ).toEqual({ handled: true, disposition: "completed" });
    expect(f.sent.map((input) => input.seq)).toEqual([1, 2]);
    expect(f.reconcileMock.mock.calls.map((call) => call[1].seq)).toEqual([1, 1, 2]);
  });

  it("pausa antes do primeiro item nao materializa nem envia e perda de lease nao vira sucesso", async () => {
    const f = fixture({ dispositionFound: false });
    await expect(
      resumePersistedCatalogPresentation(
        f.pool,
        job(),
        { workerId: "worker-a" },
        { conversationId: CONVERSATION, channelSessionId: SESSION },
        deps(
          f,
          async () => false,
          async () => true,
        ),
      ),
    ).rejects.toThrow("catalog_presentation_job_lease_lost");
    expect(f.materialize).not.toHaveBeenCalled();
    expect(f.beforeSend).not.toHaveBeenCalled();
    expect(f.sent).toEqual([]);
  });

  it("interrompe por obsolescencia antes de materializar ou enviar o primeiro item", async () => {
    const f = fixture();
    const resumeDeps = deps(f);
    resumeDeps.contracts.interruptedBeforeFirstItem = async () => true;

    const result = await resumePersistedCatalogPresentation(
      f.pool,
      job(),
      { workerId: "worker-a" },
      { conversationId: CONVERSATION, channelSessionId: SESSION },
      resumeDeps,
    );

    expect(result).toEqual({ handled: true, disposition: "interrupted" });
    expect(f.materialize).not.toHaveBeenCalled();
    expect(f.reconcileMock).not.toHaveBeenCalled();
    expect(f.beforeSend).not.toHaveBeenCalled();
    expect(f.sent).toEqual([]);
  });

  it("falha de canal sobe para o retry normal e nao reagenda como queued", async () => {
    const f = fixture({ outcomes: ["unavailable"] });

    await expect(
      resumePersistedCatalogPresentation(
        f.pool,
        job(),
        { workerId: "worker-a" },
        { conversationId: CONVERSATION, channelSessionId: SESSION },
        deps(f),
      ),
    ).rejects.toBeInstanceOf(CatalogPresentationResumeError);
    expect(f.sql.some((text) => text.includes("update job_queue"))).toBe(false);
  });

  it("o handler respeita a pausa persistida e retoma antes de classificar ou chamar o turno normal", () => {
    const source = readFileSync("lib/agent-engine/agent/inbound-turn.ts", "utf8");
    const handler = source.slice(source.indexOf("export function createInboundTurnHandler"));
    expect(handler.indexOf("resumePersistedCatalogPresentation(")).toBeGreaterThan(-1);
    expect(handler).toContain("job.catalog_presentation_snapshot");
    expect(handler).not.toContain("presentationAgent?.operationMode");
    expect(handler.indexOf("resumePersistedCatalogPresentation(")).toBeLessThan(
      handler.indexOf("const resolvedAgent = await resolveConversationTurn("),
    );
    expect(handler.indexOf("resumePersistedCatalogPresentation(")).toBeLessThan(
      handler.indexOf("runAgentTurn("),
    );
  });
});
