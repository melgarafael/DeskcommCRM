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
  BUCKET_DA_MIDIA_DA_CONVERSA,
  materializeCatalogPresentationSnapshotMedia,
  type CatalogPresentationStorage,
} from "@/lib/catalogo/materializacao-de-apresentacao";
import {
  CatalogPresentationResumeError,
  CODIGO_MIDIA_DA_APRESENTACAO_INDISPONIVEL,
  respostaAoVetoDaApresentacao,
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
      if (text.includes("insert into agent_inbox_items")) return { rows: [{ id: "inbox-1" }], rowCount: 1 };
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

  describe("veto do gate de spinning (o mesmo texto ja foi a outros clientes)", () => {
    const LOG = { info() {}, warn() {}, error() {}, debug() {} } as never;
    function vetaNoEnvio(f: ReturnType<typeof fixture>, aPartirDe: number) {
      let chamadas = 0;
      f.beforeSend = vi.fn(async (args: Parameters<typeof runBeforeSend>[0]) => {
        if (chamadas++ < aPartirDe) {
          return { status: "sent" as const, outcome: await args.send(args.body), trace: [] };
        }
        return {
          status: "vetoed" as const,
          gate: "spinning",
          code: "mass_identical",
          message: "copy repetida",
          trace: [],
        };
      }) as unknown as typeof runBeforeSend;
    }

    it("na primeira mensagem: disposicao terminal na hora, snapshot limpo, nada enviado", async () => {
      const f = fixture();
      vetaNoEnvio(f, 0);

      const result = await resumePersistedCatalogPresentation(
        f.pool,
        job(),
        { workerId: "worker-a" },
        { conversationId: CONVERSATION, channelSessionId: SESSION },
        { ...deps(f), log: LOG },
      );

      expect(result).toEqual({
        handled: true,
        disposition: "vetoed",
        code: "mass_identical",
        message: "copy repetida",
        sent: 0,
        nextSeq: 1,
      });
      expect(f.sent).toEqual([]);
      const limpeza = f.sql.find((text) => text.includes("set catalog_presentation_snapshot = null"));
      expect(limpeza).toContain("locked_by = $3");
      expect(f.sql.some((text) => text.includes("status = 'failed'"))).toBe(false);
    });

    it("no meio: devolve quantas ja sairam e a seq vetada, que fica livre para o modelo", async () => {
      const f = fixture();
      vetaNoEnvio(f, 1);

      const result = await resumePersistedCatalogPresentation(
        f.pool,
        job(2),
        { workerId: "worker-a" },
        { conversationId: CONVERSATION, channelSessionId: SESSION },
        { ...deps(f), log: LOG },
      );

      expect(result).toEqual({
        handled: true,
        disposition: "vetoed",
        code: "mass_identical",
        message: "copy repetida",
        sent: 1,
        nextSeq: 4,
      });
      expect(f.sent.map((input) => input.seq)).toEqual([3]);
    });

    it("lease perdido ao limpar o snapshot nao vira disposicao", async () => {
      const f = fixture({ dispositionFound: false });
      vetaNoEnvio(f, 0);

      await expect(
        resumePersistedCatalogPresentation(
          f.pool,
          job(),
          { workerId: "worker-a" },
          { conversationId: CONVERSATION, channelSessionId: SESSION },
          { ...deps(f), log: LOG },
        ),
      ).rejects.toThrow("catalog_presentation_job_lease_lost");
    });
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

describe("mídia do produto trocada ou apagada com a apresentação adiada (materialização real)", () => {
  const LOG = { info() {}, warn() {}, error() {}, debug() {} } as never;
  const PRODUTO_TEXTO = "ffffffff-0000-4000-8000-000000000011";
  const PRODUTO_AUDIO = "ffffffff-0000-4000-8000-000000000012";
  const AUDIO = `${ORG}/${PRODUTO_AUDIO}/99999999-aaaa-4bbb-8ccc-dddddddddddd.ogg`;
  const ORIGEM = `catalog-presentation-media\u0000${AUDIO}`;
  const OGG_OPUS = (() => {
    const bytes = new Uint8Array(48);
    bytes.set([0x4f, 0x67, 0x67, 0x53], 0);
    bytes.set(Array.from("OpusHead", (c) => c.charCodeAt(0)), 12);
    return bytes;
  })();

  function storage() {
    const objects = new Map<string, Blob>([[ORIGEM, new Blob([OGG_OPUS.slice().buffer as ArrayBuffer], { type: "audio/ogg" })]]);
    const api: CatalogPresentationStorage = {
      async download(bucket, path) {
        const data = objects.get(`${bucket}\u0000${path}`) ?? null;
        return data ? { data, error: null } : { data: null, error: { message: "not found", statusCode: 404 } };
      },
      async copy(input) {
        const destino = `${input.destination_bucket}\u0000${input.destination_path}`;
        if (objects.has(destino)) return { error: { message: "already exists", statusCode: "409" } };
        const origem = objects.get(`${input.source_bucket}\u0000${input.source_path}`);
        if (!origem) return { error: { message: "source missing", statusCode: "404" } };
        objects.set(destino, origem);
        return { error: null };
      },
    };
    return { objects, api };
  }

  function jobComMidia(ordem: ("TEXTO" | "AUDIO")[]): JobRow {
    const produtos = {
      TEXTO: {
        product_id: PRODUTO_TEXTO, product_code: "TEXTO", product_name: "Produto texto",
        price_cents: 1000, currency: "BRL", photo_storage_paths: [],
        presentation: { enabled: true, kind: "text" as const, title: null, text_content: "Descrição",
          use_catalog_photos: false, show_price: false, audio_storage_path: null, audio_mime: null },
      },
      AUDIO: {
        product_id: PRODUTO_AUDIO, product_code: "AUDIO", product_name: "Produto áudio",
        price_cents: 2000, currency: "BRL", photo_storage_paths: [],
        presentation: { enabled: true, kind: "audio" as const, title: null, text_content: null,
          use_catalog_photos: false, show_price: false, audio_storage_path: AUDIO,
          audio_mime: "audio/ogg;codecs=opus" },
      },
    };
    const planned = planCatalogPresentation({ ordered_product_codes: ordem, resolved_items: ordem.map((c) => produtos[c]) });
    if (!planned.ok) throw new Error(planned.error.code);
    return {
      ...job(),
      catalog_presentation_snapshot: {
        schema_version: 1, sends_already_counted: 0, ordered_product_codes: ordem,
        plan: planned.plan, agent_operation: OPERATION,
      },
    };
  }

  /** Quantas mensagens físicas o primeiro produto ocupa: o adiamento cai logo depois dele. */
  function mensagensDoPrimeiro(persisted: JobRow): number {
    const prepared = prepareCatalogPresentationPayloads(
      (persisted.catalog_presentation_snapshot as ReturnType<typeof snapshot>).plan,
    );
    if (!prepared.ok) throw new Error(prepared.error.code);
    return prepared.prepared.payloads.filter((p) => p.item_index === 0).length;
  }

  type Adiamento = "pausa" | "queued" | "veto com next_allowed_at";
  const ADIAMENTOS: Adiamento[] = ["pausa", "queued", "veto com next_allowed_at"];

  /** 1ª execução adiada logo depois do primeiro produto; devolve o que a 2ª precisa. */
  async function adiaDepoisDoPrimeiro(adiamento: Adiamento, ordem: ("TEXTO" | "AUDIO")[]) {
    const persisted = jobComMidia(ordem);
    const n = mensagensDoPrimeiro(persisted);
    const reconciled: number[] = [];
    const f = fixture({ reconciled, outcomes: adiamento === "queued" ? [...Array(n).fill("sent"), "queued"] : [] });
    const st = storage();
    let paused = false;
    let primeira = true;
    if (adiamento === "pausa") {
      const send = f.channel.send.bind(f.channel);
      f.channel.send = async (input) => {
        const outcome = await send(input);
        if (primeira && f.sent.length >= n) paused = true;
        return outcome;
      };
    }
    if (adiamento === "veto com next_allowed_at") {
      let chamadas = 0;
      f.beforeSend = vi.fn(async (args: Parameters<typeof runBeforeSend>[0]) => {
        if (chamadas++ === n) {
          return { status: "vetoed" as const, gate: "window", code: "outside_window", message: "fora da janela",
            nextAllowedAt: new Date("2026-10-16T07:00:00.000Z"), trace: [] };
        }
        return { status: "sent" as const, outcome: await args.send(args.body), trace: [] };
      }) as unknown as typeof runBeforeSend;
    }
    const resumeDeps = {
      ...deps(f, async () => false, async () => paused),
      log: LOG,
      clock: () => new Date("2026-10-15T22:30:00.000Z"),
    };
    resumeDeps.contracts.materialize = ((persistedSnapshot: never, input: never) =>
      materializeCatalogPresentationSnapshotMedia(persistedSnapshot, input, st.api)) as never;
    const run = () =>
      resumePersistedCatalogPresentation(
        f.pool, persisted, { workerId: "worker-a" },
        { conversationId: CONVERSATION, channelSessionId: SESSION }, resumeDeps,
      );

    expect(await run()).toEqual({ handled: true, disposition: "settled" });
    expect(persisted.catalog_presentation_snapshot).not.toBeNull();
    for (let seq = 1; seq <= n; seq++) reconciled.push(seq);
    primeira = false;
    paused = false;
    const enviadasNaPrimeira = f.sent.length;
    return { f, st, n, run, enviadasNaPrimeira };
  }

  const copiasDaConversa = (objects: Map<string, Blob>) =>
    [...objects.keys()].filter((k) => k.startsWith(`${BUCKET_DA_MIDIA_DA_CONVERSA}\u0000`));

  it.each(ADIAMENTOS)("%s: áudio ainda não enviado sai da cópia da conversa e a apresentação termina", async (adiamento) => {
    const { f, st, run, enviadasNaPrimeira } = await adiaDepoisDoPrimeiro(adiamento, ["TEXTO", "AUDIO"]);
    const [copia] = copiasDaConversa(st.objects);
    expect(copia).toBeDefined();
    st.objects.delete(ORIGEM);

    expect(await run()).toEqual({ handled: true, disposition: "completed" });
    const daSegunda = f.sent.slice(enviadasNaPrimeira);
    const audio = daSegunda.find((input) => input.media?.kind === "audio");
    expect(audio?.media?.storagePath).toBe(copia!.split("\u0000")[1]);
  });

  it.each(ADIAMENTOS)("%s: sem origem e sem cópia, encerra como o veto e devolve o turno ao modelo", async (adiamento) => {
    const { f, st, n, run, enviadasNaPrimeira } = await adiaDepoisDoPrimeiro(adiamento, ["TEXTO", "AUDIO"]);
    st.objects.delete(ORIGEM);
    for (const k of copiasDaConversa(st.objects)) st.objects.delete(k);

    const result = await run();

    expect(result).toMatchObject({
      handled: true, disposition: "vetoed", code: CODIGO_MIDIA_DA_APRESENTACAO_INDISPONIVEL, sent: n, nextSeq: n + 1,
    });
    expect(f.sent).toHaveLength(enviadasNaPrimeira);
    expect(f.sql.some((t) => t.includes("set catalog_presentation_snapshot = null"))).toBe(true);
    expect(f.sql.some((t) => t.includes("insert into agent_inbox_items"))).toBe(true);
  });

  it.each(ADIAMENTOS)("%s: áudio já enviado não precisa da origem nem da cópia, e o resto sai", async (adiamento) => {
    const { f, st, run, enviadasNaPrimeira } = await adiaDepoisDoPrimeiro(adiamento, ["AUDIO", "TEXTO"]);
    st.objects.delete(ORIGEM);
    for (const k of copiasDaConversa(st.objects)) st.objects.delete(k);

    expect(await run()).toEqual({ handled: true, disposition: "completed" });
    expect(f.sent.slice(enviadasNaPrimeira).map((input) => input.body)).toContain("Produto texto\n\nDescrição");
  });
});

describe("motivo do veto devolvido ao modelo", () => {
  it("cita o código e a mensagem do veto real, não um texto fixo", () => {
    const comercial = respostaAoVetoDaApresentacao(0, {
      code: "commercial_requires_human",
      message: "valores exigem um atendente.",
    });
    const repetida = respostaAoVetoDaApresentacao(2, { code: "mass_identical", message: "copy repetida." });

    expect(comercial.message).toContain("commercial_requires_human");
    expect(comercial.message).toContain("valores exigem um atendente.");
    expect(comercial.message).not.toContain("mensagens repetidas");
    expect(repetida.message).toContain("2 mensagem(ns)");
    expect(repetida.message).toContain("mass_identical");
  });
});
