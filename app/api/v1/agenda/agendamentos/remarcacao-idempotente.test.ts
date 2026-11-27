/**
 * REMARCAÇÃO COM CHAVE DE IDEMPOTÊNCIA (DES-1952, pedido R7 do DeskVoice).
 *
 * `crm_reschedule_appointment` chamava `alterarAgendamentoHandler` sem repassar
 * a chave do pedido. No Amigo, a chave da operação caía no `requestId`, que é
 * novo a cada requisição MCP — repetir o mesmo pedido remarcava DUAS vezes lá.
 * No caminho local não havia recibo nenhum.
 *
 * Aqui a ferramenta roda de verdade, com o handler de verdade; os dublês são
 * só o banco (local), o recibo de `idempotency_keys` (o contrato de
 * `comIdempotencia`, que tem teste próprio) e o cliente do Amigo, que passa
 * pelo diário de operações REAL (`runDurableOperation`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { McpContext } from "@/lib/mcp/types";
import type * as Idempotencia from "@/lib/api/idempotency";

const deps = vi.hoisted(() => ({
  amigoLigado: false,
  admin: { current: null as unknown },
  executeAmigo: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined), isServiceRoleConfigured: vi.fn(() => true) }));
vi.mock("@/lib/atendimento/fronteira-server", () => ({
  guardServiceEffect: vi.fn(async () => undefined),
  currentExecutionBoundary: vi.fn(() => null),
  currentExecutionJob: vi.fn(() => null),
  currentExecutionAgentOperation: vi.fn(() => null),
}));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: vi.fn(async () => deps.amigoLigado) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => deps.admin.current ?? {}) }));
vi.mock("@/lib/amigo/service", () => ({ executeAmigo: deps.executeAmigo }));
vi.mock("@/lib/agenda/consulta", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    horariosLivresDaOrg: vi.fn(async () => ({
      ok: true,
      publicouHorarios: true,
      slots: [
        { inicio: new Date("2026-12-02T14:00:00.000Z") },
        { inicio: new Date("2026-12-03T14:00:00.000Z") },
      ],
      fusoDaRegra: "America/Sao_Paulo",
    })),
  };
});

/**
 * O recibo de `idempotency_keys` em memória, com o contrato de
 * `comIdempotencia`: mesma chave + mesmo corpo = replay sem reexecutar; mesma
 * chave + outro corpo = conflito. A chave é por organização e endpoint.
 */
const recibos = new Map<string, { hash: string; resposta: unknown; status: number }>();
vi.mock("@/lib/api/idempotency", async (importOriginal) => {
  const real = await importOriginal<typeof Idempotencia>();
  return {
    ...real,
    comIdempotencia: vi.fn(async (e: Parameters<typeof real.comIdempotencia>[0]) => {
      const id = `${e.organizationId}|${e.endpoint}|${e.chave}`;
      const hash = real.hashDoCorpo(e.corpo);
      const anterior = recibos.get(id);
      if (anterior) {
        if (anterior.hash !== hash) return { tipo: "conflito" };
        return { tipo: "replay", resposta: anterior.resposta, status: anterior.status };
      }
      const { resposta, status } = await e.executar();
      recibos.set(id, { hash, resposta, status });
      return { tipo: "executou", resposta, status };
    }),
  };
});

const { crmRescheduleAppointment } = await import("@/lib/mcp/tools/agendamento");
const { runDurableOperation, privateRequestHash, operationTarget } = await import("@/lib/amigo/operations");
type Diario = Parameters<typeof runDurableOperation>[0];

const ORG = "aaaaaaaa-0000-4000-8000-00000000000a";
const COMPROMISSO = "22222222-0000-4000-8000-000000000022";
const CHAVE = "5b0c8f7e-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const DIA_2 = "2026-12-02T14:00:00.000Z";
const DIA_3 = "2026-12-03T14:00:00.000Z";

let autoridade: "local" | "amigo";
let mudancasLocais = 0;

/** O banco: o compromisso, a RPC de mudança (o efeito local) e o que o Amigo lê. */
function banco(): SupabaseClient {
  const linha = () => ({
    id: COMPROMISSO,
    revision: 1,
    event_type_id: "tipo",
    owner_user_id: null,
    contact_id: "contato",
    starts_at: "2026-12-01T14:00:00.000Z",
    ends_at: "2026-12-01T15:00:00.000Z",
    status: "confirmed",
    time_zone: "America/Sao_Paulo",
    service_occurrence_id: null,
    service_block: null,
    authority: autoridade,
    external_connection_id: autoridade === "amigo" ? "conexao" : null,
  });
  const cadeia = (tabela: string) => {
    const c: Record<string, unknown> = {};
    for (const m of ["select", "eq", "neq", "in", "is", "or", "order", "limit", "not", "gt", "lt", "gte", "lte"]) c[m] = () => c;
    const resolve = async (): Promise<{ data: unknown; error: unknown }> => {
      if (tabela === "calendar_appointments") return { data: linha(), error: null };
      if (tabela === "calendar_event_types") return { data: { id: "tipo", duration_minutes: 60, service_enabled: false }, error: null };
      if (tabela === "amigo_appointment_links") return { data: { attendance_id: 9, patient_id: 4 }, error: null };
      return { data: null, error: null };
    };
    c.maybeSingle = resolve;
    c.single = resolve;
    c.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
      (tabela === "calendar_appointments" ? Promise.resolve({ data: [linha()], error: null }) : resolve()).then(ok, ko);
    return c;
  };
  return {
    from: (tabela: string) => cadeia(tabela),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === "fn_calendar_agenda_provider")
        return { data: autoridade === "amigo" ? { id: "conexao", active: true, timezone: "America/Sao_Paulo" } : null, error: null };
      if (fn === "fn_appointment_change") {
        mudancasLocais += 1;
        return { data: { ...linha(), revision: 2, ...(args.p_patch as Record<string, unknown>) }, error: null };
      }
      return { data: null, error: null };
    },
  } as unknown as SupabaseClient;
}

/**
 * O cliente do Amigo dublado ATRÁS do diário real: a chave da operação decide se
 * a remarcação vai ao Amigo ou se a resposta gravada volta.
 */
let remarcacoesNoAmigo = 0;
function diarioEmMemoria(): Diario {
  const linhas = new Map<string, { id: string; key: string; operation: string; requestHash: string; targetId: string; state: string; result: unknown }>();
  return {
    async reserve(command) {
      const anterior = linhas.get(command.key);
      if (anterior) return { created: false, record: { ...anterior } as never };
      const nova = { ...command, id: `op-${linhas.size + 1}`, state: "prepared" };
      linhas.set(command.key, { ...nova, result: null });
      return { created: true, record: { ...nova, result: null } as never };
    },
    async update(id, state, result) {
      for (const l of linhas.values()) if (l.id === id) Object.assign(l, { state, ...(result !== undefined ? { result } : {}) });
    },
  };
}

function contexto(extra: Partial<McpContext> = {}): McpContext {
  return {
    organizationId: ORG,
    role: "ai_operator",
    actor: { type: "user", id: "pessoa", role: "admin" },
    apiTokenId: "token",
    requestId: `req-${Math.random()}`,
    supabase: banco(),
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  recibos.clear();
  mudancasLocais = 0;
  remarcacoesNoAmigo = 0;
  autoridade = "local";
  deps.amigoLigado = false;
  deps.admin.current = banco();
  const diario = diarioEmMemoria();
  deps.executeAmigo.mockImplementation(async (_ctx: unknown, operation: string, input: Record<string, unknown>, key?: string) => {
    const record = await runDurableOperation(
      diario,
      {
        key: key ?? `${Math.random()}`,
        operation,
        requestHash: privateRequestHash(operation, input),
        targetId: operationTarget(operation, input),
      },
      async () => {
        remarcacoesNoAmigo += 1;
        return { data: { id: 9 } };
      },
    );
    return { state: record.state, operation_id: record.id, local_appointment_id: COMPROMISSO, data: record.result };
  });
});

const remarcar = (args: Record<string, unknown>, ctx: McpContext) =>
  crmRescheduleAppointment.handler({ appointment_id: COMPROMISSO, ...args } as never, ctx) as Promise<Record<string, unknown>>;

describe("crm_reschedule_appointment — agenda local", () => {
  it("o argumento `idempotency_key` existe e é opcional", () => {
    expect(Object.keys(crmRescheduleAppointment.inputSchema)).toContain("idempotency_key");
  });

  it("a mesma chave (argumento) repetida remarca UMA vez e devolve a mesma resposta", async () => {
    const primeira = await remarcar({ new_starts_at: DIA_2, idempotency_key: CHAVE }, contexto());
    const repetida = await remarcar({ new_starts_at: DIA_2, idempotency_key: CHAVE }, contexto());
    expect(primeira).toMatchObject({ remarcado: true });
    expect(repetida).toEqual(primeira);
    expect(mudancasLocais).toBe(1);
  });

  it("a mesma chave pelo cabeçalho do MCP também vale", async () => {
    await remarcar({ new_starts_at: DIA_2 }, contexto({ idempotencyKey: CHAVE }));
    await remarcar({ new_starts_at: DIA_2 }, contexto({ idempotencyKey: CHAVE }));
    expect(mudancasLocais).toBe(1);
  });

  it("a mesma chave com outro horário é idempotency_conflict, e nada muda", async () => {
    await remarcar({ new_starts_at: DIA_2, idempotency_key: CHAVE }, contexto());
    const outra = await remarcar({ new_starts_at: DIA_3, idempotency_key: CHAVE }, contexto());
    expect(outra).toMatchObject({ remarcado: false, motivo: "idempotency_conflict" });
    expect(mudancasLocais).toBe(1);
  });

  it("sem chave, nada muda: cada chamada remarca", async () => {
    await remarcar({ new_starts_at: DIA_2 }, contexto());
    await remarcar({ new_starts_at: DIA_2 }, contexto());
    expect(mudancasLocais).toBe(2);
    expect(recibos.size).toBe(0);
  });
});

describe("crm_reschedule_appointment — agenda do Amigo", () => {
  beforeEach(() => {
    autoridade = "amigo";
    deps.amigoLigado = true;
    deps.admin.current = banco();
  });

  it("a mesma chave repetida (requisições diferentes) remarca UMA vez no Amigo", async () => {
    const primeira = await remarcar({ new_starts_at: DIA_2, idempotency_key: CHAVE }, contexto());
    const repetida = await remarcar({ new_starts_at: DIA_2, idempotency_key: CHAVE }, contexto());
    expect(primeira).toMatchObject({ remarcado: true });
    expect(repetida).toEqual(primeira);
    expect(remarcacoesNoAmigo).toBe(1);
    // A chave do pedido é a que chega à operação do Amigo, não o requestId.
    expect(deps.executeAmigo.mock.calls[0]?.[3]).toBe(CHAVE);
  });

  it("pelo cabeçalho do MCP, a chave também chega ao Amigo", async () => {
    await remarcar({ new_starts_at: DIA_2 }, contexto({ idempotencyKey: CHAVE }));
    await remarcar({ new_starts_at: DIA_2 }, contexto({ idempotencyKey: CHAVE }));
    expect(remarcacoesNoAmigo).toBe(1);
  });

  it("a mesma chave com outro horário é idempotency_conflict, e o Amigo não é chamado de novo", async () => {
    await remarcar({ new_starts_at: DIA_2, idempotency_key: CHAVE }, contexto());
    const outra = await remarcar({ new_starts_at: DIA_3, idempotency_key: CHAVE }, contexto());
    expect(outra).toMatchObject({ remarcado: false, motivo: "idempotency_conflict" });
    expect(remarcacoesNoAmigo).toBe(1);
  });

  it("sem chave, nada muda: cada requisição é uma operação", async () => {
    await remarcar({ new_starts_at: DIA_2 }, contexto());
    await remarcar({ new_starts_at: DIA_2 }, contexto());
    expect(remarcacoesNoAmigo).toBe(2);
  });
});
