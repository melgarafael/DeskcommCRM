import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { ChannelAdapter, ChannelSendInput } from "@/lib/agent-engine/channel-adapter";
import type { runBeforeSend } from "@/lib/agent-engine/guardrails/before-send";
import type { reconcileAcceptedSend } from "@/lib/agent-engine/edge/crm/send-ledger";
import type { JobRow } from "@/lib/agent-engine/queue/queue";
import { generateText, stepCountIs, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import {
  apresentacaoEncerraTurno,
  terminalizarApresentacaoNoTurno,
} from "./terminalidade-de-apresentacao";
import { prepareCatalogPresentationPayloads } from "./preparo-de-apresentacao";
import {
  CHAVE_DO_SNAPSHOT_DA_APRESENTACAO,
  resolveAndSnapshotCatalogPresentation,
} from "./snapshot-de-apresentacao";
import { resumePersistedCatalogPresentation } from "./retomada-de-apresentacao";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const JOB = "bbbbbbbb-0000-4000-8000-000000000001";
const CONTACT = "cccccccc-0000-4000-8000-000000000001";
const CONVERSATION = "dddddddd-0000-4000-8000-000000000001";
const SESSION = "eeeeeeee-0000-4000-8000-000000000001";
const OPERATION = {organizationId:ORG,agentId:"99999999-0000-4000-8000-000000000001",versionId:"99999999-0000-4000-8000-000000000002",revision:"3"};
const CLAIM = { worker_id: "worker-a", acquired_at: "2026-10-15T12:00:00.000Z" };

function fixture(
  outcomes: Array<"sent" | "queued"> = ["sent", "sent"],
  options: { withoutPresentation?: boolean } = {},
) {
  const events: string[] = [];
  const sends: ChannelSendInput[] = [];
  const reconciled: number[] = [];
  const payload: Record<string, unknown> = { existing: "kept" };
  let presentationSnapshot: unknown = null;
  let status = "running";
  let sendIndex = 0;
  const rows = ["B", "A"].map((code, index) => ({
    product_id: `ffffffff-0000-4000-8000-00000000000${index + 1}`,
    product_code: code,
    product_name: `Produto ${code}`,
    price_cents: "1000",
    currency: "BRL",
    photo_storage_paths: [],
    presentation_id:
      options.withoutPresentation && code === "A"
        ? null
        : `99999999-0000-4000-8000-00000000000${index + 1}`,
    presentation_enabled: true,
    presentation_kind: "text",
    presentation_title: null,
    presentation_text_content: `Texto ${code}`,
    presentation_use_catalog_photos: false,
    presentation_show_price: false,
    presentation_audio_storage_path: null,
    presentation_audio_mime: null,
  }));
  const query = async (sql: string, values?: unknown[]) => {
    if (["begin", "commit", "rollback"].includes(sql)) {
      events.push(sql);
      return { rows: [], rowCount: null };
    }
    if (sql.includes("fn_service_lock")) return {rows:[],rowCount:1};
    if (sql.includes("from ai_agents")) return {rows:[{published_version_id:OPERATION.versionId,operation_revision:OPERATION.revision,operation_mode:"automatic",paused_at:null,archived_at:null}],rowCount:1};
    if (sql.includes("as current")) return {rows:[{current:true}],rowCount:1};
    if (sql.includes("from public.job_queue") && sql.includes("for update")) {
      expect(values?.slice(0, 4)).toEqual([JOB, ORG, CLAIM.worker_id, CLAIM.acquired_at]);
      return { rows: [{ catalog_presentation_snapshot: presentationSnapshot }], rowCount: 1 };
    }
    if (sql.includes("from public.catalog_products")) {
      expect(values?.[0]).toBe(ORG);
      const selected = rows.filter((row) => (values?.[1] as string[]).includes(row.product_code));
      return { rows: selected, rowCount: selected.length };
    }
    if (sql.includes("update public.job_queue")) {
      presentationSnapshot = JSON.parse(String(values?.[5]));
      events.push("snapshot-written");
      return { rows: [{ id: JOB }], rowCount: 1 };
    }
    if (sql.includes("select source, consent, is_anonymized")) {
      expect(values).toEqual([ORG, CONTACT]);
      return { rows: [{ source: "whatsapp", consent: {}, is_anonymized: false }], rowCount: 1 };
    }
    if (sql.includes("update job_queue")) {
      expect(values).toContain(JOB);
      status = "pending";
      events.push("job-requeued");
      return { rows: [{ id: JOB }], rowCount: 1 };
    }
    throw new Error(`unexpected_query: ${sql}`);
  };
  const pool = {
    connect: async () => ({ query, release: () => undefined }),
    query,
  } as unknown as Pool;
  const channel = {
    channel: "test",
    send: async (input: ChannelSendInput) => {
      events.push("channel-send");
      sends.push(input);
      const kind = outcomes[sendIndex++] ?? "sent";
      return { kind, idempotencyKey: `key-${input.seq}`, messageId: `message-${input.seq}` };
    },
  } as ChannelAdapter;
  const beforeSend = vi.fn(async (args: Parameters<typeof runBeforeSend>[0]) => ({
    status: "sent" as const,
    outcome: await args.send(args.body),
    trace: [],
  })) as unknown as typeof runBeforeSend;
  const reconcileMock = vi.fn(async (_pool: unknown, input: { seq: number }) =>
    reconciled.includes(input.seq),
  );
  const reconcile = reconcileMock as unknown as typeof reconcileAcceptedSend;
  const materialize = vi.fn(async (persisted: { snapshot: { plan: never } }) => {
    const prepared = prepareCatalogPresentationPayloads(persisted.snapshot.plan);
    if (!prepared.ok) throw new Error(prepared.error.code);
    return {
      ok: true as const,
      materialized: {
        physical_payload_count: prepared.prepared.physical_payload_count,
        payloads: prepared.prepared.payloads.map((entry) => ({ payload: entry })),
      },
    };
  });
  const job = (): JobRow => ({
    id: JOB,
    organization_id: ORG,
    contact_id: CONTACT,
    kind: "inbound_turn",
    source_event_id: null,
    payload,
    catalog_presentation_snapshot: presentationSnapshot,
    status: "running",
    priority: 100,
    run_after: new Date(),
    attempts: 1,
    max_attempts: 5,
    last_error: null,
    locked_by: CLAIM.worker_id,
    locked_at: new Date(CLAIM.acquired_at),
    claim_acquired_at: CLAIM.acquired_at,
    created_at: new Date(),
  });
  const resume = (maxSendsPerTurn = 10) =>
    resumePersistedCatalogPresentation(
      pool,
      job(),
      { workerId: CLAIM.worker_id },
      { conversationId: CONVERSATION, channelSessionId: SESSION },
      {
        channel,
        log: {} as never,
        maxSendsPerTurn,
        queuedRetryDelayMs: 30_000,
        respostaObsoletaTetoMs: 0,
        contracts: {
          beforeSend,
          reconcileAcceptedSend: reconcile,
          materialize: materialize as never,
          interruptedBeforeFirstItem: async () => false,
          interruptedBetweenItems: async () => false,
          agentPaused: async () => false,
        },
      },
    );
  return {
    pool,
    job,
    resume,
    events,
    sends,
    reconciled,
    reconcileMock,
    beforeSend,
    materialize,
    status: () => status,
  };
}

async function snapshot(f: ReturnType<typeof fixture>, sendsAlreadyCounted = 0) {
  const result = await resolveAndSnapshotCatalogPresentation(f.pool, {
    organizationId: ORG,
    contactId: CONTACT,
    agentOperation: OPERATION,
    jobId: JOB,
    claim: CLAIM,
    sendsAlreadyCounted,
    maxSendsPerTurn: 10,
    orderedProductCodes: ["A", "B"],
  });
  if (!result.ok) throw new Error(result.error.code);
  return result;
}

describe("integração da seleção persistida com a disposição do worker", () => {
  it.each([
    {
      name: "item sem apresentação",
      codes: ["A"],
      withoutPresentation: true,
      limit: 10,
      code: "presentation_not_found",
    },
    {
      name: "código inexistente",
      codes: ["INEXISTENTE"],
      withoutPresentation: false,
      limit: 10,
      code: "product_not_found",
    },
    {
      name: "lista acima do teto",
      codes: ["A", "B"],
      withoutPresentation: false,
      limit: 1,
      code: "max_sends_per_turn",
    },
  ])("$name devolve o controle ao agente para responder ao cliente", async (case_) => {
    const f = fixture([], { withoutPresentation: case_.withoutPresentation });
    const responder = vi.fn(async () => ({ ok: true, message: "Resposta ao cliente" }));
    const acionada = vi.fn();
    const tools = terminalizarApresentacaoNoTurno(
      {
        present_catalog_items: tool({
          inputSchema: z.object({ product_codes: z.array(z.string()) }),
          execute: async ({ product_codes }) => {
            const selection = await resolveAndSnapshotCatalogPresentation(f.pool, {
              organizationId: ORG,
              contactId: CONTACT,
              agentOperation: OPERATION,
              jobId: JOB,
              claim: CLAIM,
              sendsAlreadyCounted: 0,
              maxSendsPerTurn: case_.limit,
              orderedProductCodes: product_codes,
            });
            return selection.ok
              ? { ok: true }
              : { ok: false, code: `catalog_presentation_${selection.error.code}` };
          },
        }),
        send_message: tool({ inputSchema: z.object({}), execute: responder }),
      },
      "present_catalog_items",
      acionada,
      apresentacaoEncerraTurno,
    );
    const options = { toolCallId: "turno", messages: [], context: {} };
    const presentation = await tools.present_catalog_items!.execute!(
      { product_codes: case_.codes } as never,
      options,
    );
    expect(presentation).toEqual({ ok: false, code: `catalog_presentation_${case_.code}` });
    expect(await tools.send_message!.execute!({} as never, options)).toEqual({
      ok: true,
      message: "Resposta ao cliente",
    });
    expect(responder).toHaveBeenCalledOnce();
    expect(acionada).not.toHaveBeenCalled();
    expect(f.job().payload).not.toHaveProperty(CHAVE_DO_SNAPSHOT_DA_APRESENTACAO);
    expect(f.sends).toEqual([]);
  });

  it.each([
    { name: "presentation_not_found", codes: ["A"], withoutPresentation: true, limit: 10 },
    { name: "product_not_found", codes: ["INEXISTENTE"], withoutPresentation: false, limit: 10 },
    { name: "max_sends_per_turn", codes: ["A", "B"], withoutPresentation: false, limit: 1 },
  ])("SDK continua o turno após $name e entrega a resposta ao lead", async (case_) => {
    const f = fixture([], { withoutPresentation: case_.withoutPresentation });
    const leadMessages: string[] = [];
    const acionada = vi.fn();
    const responder = vi.fn(async ({ message }: { message: string }) => {
      leadMessages.push(message);
      return { ok: true, message };
    });
    const tools = terminalizarApresentacaoNoTurno(
      {
        present_catalog_items: tool({
          inputSchema: z.object({ product_codes: z.array(z.string()) }),
          execute: async ({ product_codes }) => {
            const selection = await resolveAndSnapshotCatalogPresentation(f.pool, {
              organizationId: ORG,
              contactId: CONTACT,
              agentOperation: OPERATION,
              jobId: JOB,
              claim: CLAIM,
              sendsAlreadyCounted: 0,
              maxSendsPerTurn: case_.limit,
              orderedProductCodes: product_codes,
            });
            return selection.ok
              ? { ok: true }
              : { ok: false, code: `catalog_presentation_${selection.error.code}` };
          },
        }),
        send_message: tool({
          inputSchema: z.object({ message: z.string() }),
          execute: responder,
        }),
      },
      "present_catalog_items",
      acionada,
      apresentacaoEncerraTurno,
    );
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        const step = model.doGenerateCalls.length;
        if (step === 2) {
          expect(JSON.stringify(options.prompt)).toContain(`catalog_presentation_${case_.name}`);
        }
        return {
          content:
            step === 1
              ? [
                  {
                    type: "tool-call",
                    toolCallId: "presentation",
                    toolName: "present_catalog_items",
                    input: JSON.stringify({ product_codes: case_.codes }),
                  },
                ]
              : step === 2
                ? [
                    {
                      type: "tool-call",
                      toolCallId: "reply",
                      toolName: "send_message",
                      input: JSON.stringify({ message: "Resposta ao cliente" }),
                    },
                  ]
                : [{ type: "text", text: "" }],
          finishReason: {
            unified: step < 3 ? "tool-calls" : "stop",
            raw: step < 3 ? "tool_calls" : "stop",
          },
          usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
        } as never;
      },
    });

    const result = await generateText({
      model,
      prompt: "O lead pediu uma apresentação de catálogo.",
      tools,
      stopWhen: stepCountIs(3),
    });

    expect(model.doGenerateCalls).toHaveLength(3);
    expect(result.steps[0]?.toolResults[0]?.output).toMatchObject({
      ok: false,
      code: `catalog_presentation_${case_.name}`,
    });
    expect(result.steps[1]?.toolCalls[0]?.toolName).toBe("send_message");
    expect(responder).toHaveBeenCalledOnce();
    expect(leadMessages).toEqual(["Resposta ao cliente"]);
    expect(acionada).not.toHaveBeenCalled();
    expect(f.job().payload).not.toHaveProperty(CHAVE_DO_SNAPSHOT_DA_APRESENTACAO);
    expect(f.sends).toEqual([]);
    expect(f.events).not.toContain("snapshot-written");
  });

  it("commita o snapshot antes do canal e conclui na ordem e seq congeladas", async () => {
    const f = fixture();
    await snapshot(f, 2);
    expect(await f.resume()).toEqual({ handled: true, disposition: "completed" });
    expect(f.events.slice(0, 4)).toEqual(["begin", "snapshot-written", "commit", "channel-send"]);
    expect(f.job().catalog_presentation_snapshot).toMatchObject({schema_version:1,agent_operation:OPERATION});
    expect(f.job().payload.existing).toBe("kept");
    expect(f.sends.map((send) => [send.seq, send.body, send.tenantId, send.jobId])).toEqual([
      [3, "Produto A\n\nTexto A", ORG, JOB],
      [4, "Produto B\n\nTexto B", ORG, JOB],
    ]);
    expect(f.reconcileMock.mock.calls.map((call) => call[1].seq)).toEqual([3, 4]);
    expect(f.beforeSend).toHaveBeenCalledTimes(2);
  });

  it("queued preserva o snapshot e o mesmo job; replay reconcilia a seq sem duplicar", async () => {
    const f = fixture(["queued", "sent"]);
    await snapshot(f);
    const persisted = structuredClone({payload:f.job().payload,snapshot:f.job().catalog_presentation_snapshot});
    expect(await f.resume()).toEqual({ handled: true, disposition: "settled" });
    expect(f.status()).toBe("pending");
    expect({payload:f.job().payload,snapshot:f.job().catalog_presentation_snapshot}).toEqual(persisted);
    expect(f.sends.map((send) => send.seq)).toEqual([1]);
    f.reconciled.push(1);
    expect(await f.resume()).toEqual({ handled: true, disposition: "completed" });
    expect(f.sends.map((send) => send.seq)).toEqual([1, 2]);
    expect(f.reconcileMock.mock.calls.map((call) => call[1].seq)).toEqual([1, 1, 2]);
  });

  it("teto insuficiente barra antes de ledger, guardrail ou canal", async () => {
    const f = fixture();
    await snapshot(f, 2);
    await expect(f.resume(3)).rejects.toThrow("catalog_presentation_max_sends_per_turn");
    expect(f.reconcileMock).not.toHaveBeenCalled();
    expect(f.beforeSend).not.toHaveBeenCalled();
    expect(f.sends).toEqual([]);
  });
});
