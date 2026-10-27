/** Resume → executor → BeforeSend → adapter → sendTurnMessage → handler reais.
 * Só PG/REST e transporte são controlados. O seam de gates=[] isola a operação;
 * não modifica nenhuma guarda de produção nem dispensa a conferência canônica.
 */
import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tool } from "ai";
import { z } from "zod";

import type { AgentOperationContext } from "@/lib/ai/agents/operation";
import type { JobRow } from "@/lib/agent-engine/queue/queue";
import { WahaChannelAdapter } from "@/lib/agent-engine/edge/channel/waha-adapter";
import { runBeforeSend } from "@/lib/agent-engine/guardrails/before-send";
import { StaleServiceBoundaryError, type ServiceBoundary } from "@/lib/atendimento/fronteira";
import { planCatalogPresentation } from "@/lib/catalogo/plano-de-apresentacao";
import { prepareCatalogPresentationPayloads } from "@/lib/catalogo/preparo-de-apresentacao";
import { resumePersistedCatalogPresentation, type CatalogPresentationResumeDeps } from "@/lib/catalogo/retomada-de-apresentacao";
import { CHAVE_DO_SNAPSHOT_DA_APRESENTACAO } from "@/lib/catalogo/snapshot-de-apresentacao";
import { criarDubleDoHandler } from "@/tests/helpers/duble-do-handler";
import { terminalizarApresentacaoNoTurno, apresentacaoEncerraTurno } from "@/lib/catalogo/terminalidade-de-apresentacao";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ storage: { from: () => ({ createSignedUrl: vi.fn() }) } }) }));

const ORG = "a9019000-0000-4000-8000-000000000001";
const CONTACT = "a9019000-0000-4000-8000-000000000002";
const CONV = "a9019000-0000-4000-8000-000000000003";
const SESSION = "a9019000-0000-4000-8000-000000000004";
const AGENT = "a9019000-0000-4000-8000-000000000005";
const VERSION = "a9019000-0000-4000-8000-000000000006";
const JOB_ID = "a9019000-0000-4000-8000-000000000007";
const BOUNDARY: ServiceBoundary = {
  organization_id: ORG, contact_id: CONTACT, conversation_id: CONV,
  service_revision: 1, demanda_id: null, demanda_revision: null,
};
const OPERATION: AgentOperationContext = { organizationId: ORG, agentId: AGENT, versionId: VERSION, revision: "3" };
const planned = planCatalogPresentation({
  ordered_product_codes: ["A", "B"],
  resolved_items: ["A", "B"].map((code, i) => ({
    product_id: `a9019000-1111-4000-8000-00000000000${i + 1}`, product_code: code,
    product_name: `Produto ${code}`, price_cents: 100, currency: "BRL", photo_storage_paths: [],
    presentation: { enabled: true, kind: "text" as const, title: null, text_content: `Texto ${code}`,
      use_catalog_photos: false, show_price: false, audio_storage_path: null, audio_mime: null },
  })),
});
if (!planned.ok) throw Error(planned.error.code);
const SNAPSHOT = { schema_version: 1 as const, sends_already_counted: 0, ordered_product_codes: ["A", "B"], plan: planned.plan, agent_operation: OPERATION };
const JOB = {
  id: JOB_ID, organization_id: ORG, contact_id: CONTACT, kind: "inbound_turn", status: "running",
  payload: { service_boundary: BOUNDARY }, catalog_presentation_snapshot: SNAPSHOT,
  locked_by: "worker", claim_acquired_at: "2026-10-27T00:00:00.000Z",
} as JobRow;

function world(change?: (state: ReturnType<typeof stateOfAgent>) => void, currentLease = true) {
  const state = stateOfAgent();
  const boundary = () => ({ ...BOUNDARY, status: "open", demanda_fechada_em: null });
  const { supabase, mensagens } = criarDubleDoHandler({
    conversation: { id: CONV, organization_id: ORG, contact_id: CONTACT, channel_session_id: SESSION,
      is_group: false, group_chat_id: null,
      contacts: { phone_number: "+5531999998888", wa_identity: null, wa_lid: null, is_blocked: false },
      channel_sessions: { provider: "waha", waha_session_name: "default", status: "WORKING", archived_at: null, metadata: {} } },
    agente: () => structuredClone(state), rpcData: boundary,
  });
  let ledgerNumber = 0;
  const agentChecks: unknown[][] = [];
  async function query(sql: string, values: unknown[] = []) {
    const s = sql.replace(/\s+/g, " ").trim().toLowerCase();
    if (s.includes("from ai_agents")) {
      expect(values).toEqual([ORG, AGENT]); agentChecks.push(values);
      return { rows: [structuredClone(state)], rowCount: 1 };
    }
    if (s.startsWith("select payload,kind from job_queue")) {
      expect(values).toEqual([JOB_ID, ORG, CONTACT]); return { rows: [structuredClone(JOB)], rowCount: 1 };
    }
    if (s.includes("as current")) return { rows: [{ current: currentLease }], rowCount: 1 };
    if (s.includes("from conversations c left join demandas")) return { rows: [boundary()], rowCount: 1 };
    if (s.includes("select source, consent, is_anonymized")) return { rows: [{ source: "whatsapp", consent: {}, is_anonymized: false }], rowCount: 1 };
    if (s.startsWith("insert into send_ledger")) return { rows: [{ id: `a9019000-2222-4000-8000-00000000000${++ledgerNumber}` }], rowCount: 1 };
    if (s.startsWith("insert into before_send_traces")) return { rows: [{ id: "a9019000-3333-4000-8000-000000000001" }], rowCount: 1 };
    if (["begin", "commit", "rollback"].includes(s) || s.startsWith("select pg_advisory_xact_lock")) return { rows: [], rowCount: 0 };
    if (s.includes("from organizations o left join channel_knobs")) return { rows: [], rowCount: 0 };
    if (s.includes("from channel_sessions") || s.includes("from channel_knobs") || s.includes("from channel_session_health") ||
        s.includes("from pacing_ledger") || s.includes("from outbound_copies") || s.includes("from promise_table_pointers") ||
        s.includes("from disclosure_template_pointers") || s.includes("from send_ledger") || s.includes("from contacts") ||
        s.includes("from conversations") || s.startsWith("insert into pacing_ledger") || s.startsWith("insert into outbound_copies") ||
        s.startsWith("update send_ledger")) return { rows: [], rowCount: 0 };
    throw Error(`consulta inesperada: ${s}`);
  }
  const pool = { query, connect: async () => ({ query, release: vi.fn() }) } as unknown as Pool;
  const posts: string[] = [];
  vi.stubEnv("WAHA_API_BASE_URL", "http://localhost:3030");
  vi.stubEnv("WAHA_API_KEY", "test-placeholder-waha-key");
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
    if (!String(url).startsWith("http://localhost:3030/")) throw Error("rede externa não autorizada no teste");
    if (String(url).includes("/api/sendText")) posts.push(String(init?.body));
    return new Response(JSON.stringify({ id: { id: `3EB0${posts.length}` } }), { status: 200 });
  }));
  let pauseChecks = 0;
  const deps: CatalogPresentationResumeDeps = {
    channel: new WahaChannelAdapter(pool, { supabase }),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    maxSendsPerTurn: 10, queuedRetryDelayMs: 30_000, respostaObsoletaTetoMs: 0,
    clock: () => new Date("2026-10-27T12:00:00.000Z"),
    sleep: async () => {},
    contracts: {
      beforeSend: args => runBeforeSend({ ...args, gates: [] }),
      interruptedBeforeFirstItem: async () => false, interruptedBetweenItems: async () => false,
      agentPaused: async () => {
        const paused = state.paused_at !== null;
        // Leitura vigente, seguida da mudança concorrente: a 2ª bolha não pode
        // confiar no booleano lido antes de começar o corte real do envio.
        if (++pauseChecks === 3) change?.(state);
        return paused;
      },
      materialize: async () => {
        const prepared = prepareCatalogPresentationPayloads(SNAPSHOT.plan);
        if (!prepared.ok) throw Error(prepared.error.code);
        return { ok: true, materialized: { physical_payload_count: prepared.prepared.physical_payload_count,
          payloads: prepared.prepared.payloads.map(payload => ({ payload })) } };
      },
    },
  };
  return { pool, deps, posts, mensagens, agentChecks };
}
function stateOfAgent() {
  return { published_version_id: VERSION, operation_revision: "3", operation_mode: "automatic", paused_at: null as string | null, archived_at: null };
}
function run(w: ReturnType<typeof world>, job: JobRow = JOB) {
  return resumePersistedCatalogPresentation(w.pool, job, { workerId: "worker" }, { conversationId: CONV, channelSessionId: SESSION }, w.deps);
}
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("a apresentação conserva a operação original até o efeito real", () => {
  it("controle: replay em nova invocação usa só a operação original persistida e entrega dois payloads reais", async () => {
    const w = world(); const afterRestart = JSON.parse(JSON.stringify(JOB)) as JobRow;
    await expect(run(w, afterRestart)).resolves.toMatchObject({ handled: true, disposition: "completed" });
    expect(w.posts).toHaveLength(2); expect(w.mensagens).toHaveLength(2);
  });
  it.each([
    ["pausa", (s: ReturnType<typeof stateOfAgent>) => { s.paused_at = "2026-10-27T12:00:00.000Z"; }],
    ["revisão", (s: ReturnType<typeof stateOfAgent>) => { s.operation_revision = "4"; }],
    ["modo", (s: ReturnType<typeof stateOfAgent>) => { s.operation_mode = "assisted"; }],
  ] as const)("%s alterada depois da leitura e antes da 2ª bolha bloqueia o segundo POST", async (_name, change) => {
    const w = world(change); let failure: unknown;
    try { await run(w); } catch (error) { failure = error; }
    expect(w.posts).toHaveLength(1); expect(w.mensagens).toHaveLength(1);
    expect(failure).toBeInstanceOf(StaleServiceBoundaryError);
    expect(w.agentChecks.length).toBeGreaterThan(1);
  });
});


describe("a origem e o lease da retomada falham fechados", () => {
  it("payload legado não controla replay e colunaNULL devolve o caminho normal", async () => {
    const w=world();
    const forged={...JOB,catalog_presentation_snapshot:null,payload:{...JOB.payload,[CHAVE_DO_SNAPSHOT_DA_APRESENTACAO]:SNAPSHOT}};
    await expect(run(w,forged)).resolves.toEqual({handled:false});
    expect(w.posts).toHaveLength(0);expect(w.mensagens).toHaveLength(0);expect(w.agentChecks).toHaveLength(0);
  });
  it("lease perdido antes do replay não produz efeito", async () => {
    const w=world(undefined,false);
    await expect(run(w)).rejects.toBeInstanceOf(StaleServiceBoundaryError);
    expect(w.posts).toHaveLength(0);expect(w.mensagens).toHaveLength(0);
  });
  it.each([
    ["ausente",undefined],
    ["outra organização",{...OPERATION,organizationId:"b9019000-0000-4000-8000-000000000001"}],
    ["contexto inteiro",{...OPERATION,prompt:"não deve ser aceito como identidade"}],
  ])("identidade original%s recusa retomada, sem consultar agente mais recente",async(_name,operation)=>{
    const w=world(), job={...JOB,catalog_presentation_snapshot:{...SNAPSHOT,agent_operation:operation}};
    await expect(run(w,job)).rejects.toThrow("catalog_presentation_snapshot_invalid");
    expect(w.posts).toHaveLength(0);expect(w.agentChecks).toHaveLength(0);
  });
});

it("falha canônica após uma bolha também impede o fallback da ferramenta irmã",async()=>{
  const w=world(state=>{state.operation_revision="4";});
  const fallback=vi.fn(async()=>({ok:true}));
  const activated=vi.fn();
  const tools=terminalizarApresentacaoNoTurno({
    present_catalog_items:tool({inputSchema:z.object({}),execute:()=>run(w)}),
    send_message:tool({inputSchema:z.object({}),execute:fallback}),
  },"present_catalog_items",activated,apresentacaoEncerraTurno);
  const options={toolCallId:"apresentacao",messages:[],context:{}};
  await expect(tools.present_catalog_items!.execute!({} as never,options)).rejects.toBeInstanceOf(StaleServiceBoundaryError);
  expect(await tools.send_message!.execute!({} as never,options)).toMatchObject({ok:false,error:{code:"catalog_presentation_terminal"}});
  expect(fallback).not.toHaveBeenCalled();expect(activated).toHaveBeenCalledOnce();
  expect(w.posts).toHaveLength(1);expect(w.mensagens).toHaveLength(1);
});
