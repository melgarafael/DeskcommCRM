/**
 * RESPONSÁVEIS DA CONSULTA (#3067, F2) — o PATCH no handler, contra um dublê do
 * Supabase. Prova três coisas da camada de rota:
 *
 *  1. sem `responsible_user_ids` no pedido, a resposta NÃO ganha `responsaveis`;
 *  2. a resposta e a auditoria leem o que o BANCO gravou (releitura), e a
 *     auditoria sai só quando a lista mudou de fato;
 *  3. erro nomeado do banco vira o código de resposta nomeado (não 422 genérico).
 *
 * A regra de banco (teto, membro, ocupação) está em
 * `tests/invariants/agenda-responsaveis.test.ts`; aqui o dublê só devolve o que o
 * banco devolveria, e a asserção é sobre o que o handler faz com isso.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { ApiError } from "@/lib/api/types";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { audit } from "@/lib/audit";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined), isServiceRoleConfigured: vi.fn(() => true) }));
vi.mock("@/lib/atendimento/fronteira-server", () => ({
  guardServiceEffect: vi.fn(async () => undefined),
  currentExecutionBoundary: vi.fn(() => null),
  currentExecutionJob: vi.fn(() => null),
  currentExecutionAgentOperation: vi.fn(() => null),
}));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: vi.fn(async () => false) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
// A grade de horário livre é outra peça: aqui basta dizer que o horário pedido está livre.
vi.mock("@/lib/agenda/consulta", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    horariosLivresDaOrg: vi.fn(async () => ({
      ok: true,
      publicouHorarios: true,
      slots: [{ inicio: new Date("2026-12-01T14:00:00.000Z") }],
      fusoDaRegra: "America/Sao_Paulo",
    })),
  };
});

const { alterarAgendamentoHandler, marcarAgendamentoHandler } = await import("./_handler");

const ORG = "aaaaaaaa-0000-4000-8000-00000000000a";
const USUARIO = "cccccccc-0000-4000-8000-00000000000c";
const PRINCIPAL = "dddddddd-0000-4000-8000-00000000000d";
const COMPROMISSO = "22222222-0000-4000-8000-000000000022";
const TIPO = "eeeeeeee-0000-4000-8000-00000000000e";
const X = "11111111-0000-4000-8000-000000000011";
const Y = "33333333-0000-4000-8000-000000000033";

interface Estado {
  /** Adicionais que o banco tem ANTES do PATCH. */
  antes: string[];
  /** Adicionais que o banco tem DEPOIS do PATCH (o que a releitura devolve). */
  depois: string[];
  /** Erro que a RPC de mudança devolve (se houver). */
  erroRpc?: { message: string; code?: string; details?: string | null };
  /** Erro na releitura da tabela de responsáveis. */
  erroReleitura?: boolean;
  /** Corpo que a RPC devolve como linha salva. */
  linhaSalva?: Record<string, unknown>;
  /** O que `fn_colegas_podem_mexer_na_agenda` devolve (ausente = ligada). */
  chaveDosColegas?: boolean;
}

let estado: Estado;
const chamadasRpc: Array<{ fn: string; args: Record<string, unknown> }> = [];

/**
 * Dublê mínimo. `calendar_appointment_responsibles` devolve `antes` na 1ª leitura
 * (antes do PATCH) e `depois` nas seguintes (releitura). `calendar_appointments`
 * devolve o compromisso. A cadeia aceita qualquer filtro.
 */
function supabaseFake(): SupabaseClient {
  let leiturasDeResponsaveis = 0;
  const cadeia = (tabela: string) => {
    const c: Record<string, unknown> = {};
    for (const m of ["eq", "neq", "in", "is", "or", "order", "limit", "not", "gt", "lt", "gte", "lte"]) {
      c[m] = () => c;
    }
    c.select = () => c;
    const resolve = async (): Promise<{ data: unknown; error: unknown }> => {
      if (tabela === "calendar_appointment_responsibles") {
        leiturasDeResponsaveis += 1;
        if (leiturasDeResponsaveis === 1) {
          return { data: estado.antes.map((user_id) => ({ user_id })), error: null };
        }
        if (estado.erroReleitura) return { data: null, error: { message: "falha de leitura" } };
        return { data: estado.depois.map((user_id) => ({ user_id })), error: null };
      }
      if (tabela === "calendar_appointments") {
        return {
          data: {
            id: COMPROMISSO,
            revision: 1,
            event_type_id: null,
            owner_user_id: PRINCIPAL,
            contact_id: null,
            starts_at: "2026-12-01T14:00:00.000Z",
            ends_at: "2026-12-01T15:00:00.000Z",
            status: "confirmed",
            time_zone: "America/Sao_Paulo",
            service_occurrence_id: null,
            service_block: null,
            authority: "local",
          },
          error: null,
        };
      }
      if (tabela === "user_organizations") {
        return { data: [{ user_id: X }, { user_id: Y }].map((m) => m), error: null };
      }
      return { data: [], error: null };
    };
    c.maybeSingle = resolve;
    c.single = resolve;
    c.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => resolve().then(ok, ko);
    return c;
  };
  return {
    from: (tabela: string) => cadeia(tabela),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      chamadasRpc.push({ fn, args });
      if (fn === "fn_colegas_podem_mexer_na_agenda") return { data: estado.chaveDosColegas ?? true, error: null };
      if (estado.erroRpc) return { data: null, error: estado.erroRpc };
      const patch = (args.p_patch ?? {}) as Record<string, unknown>;
      return {
        data: { ...(estado.linhaSalva ?? {}), id: COMPROMISSO, revision: 2, time_zone: "America/Sao_Paulo", status: "confirmed", ...patch, responsible_user_ids: undefined },
        error: null,
      };
    },
  } as unknown as SupabaseClient;
}

const ctx = {
  organization_id: ORG,
  requestId: "req-responsaveis",
  actor: { type: "user", id: USUARIO, role: "admin" },
  escoposDoToken: [],
} as unknown as HandlerCtx;

beforeEach(() => {
  vi.clearAllMocks();
  chamadasRpc.length = 0;
  estado = { antes: [], depois: [] };
});

describe("PATCH de responsáveis — o handler lê o que o banco gravou", () => {
  it("sem responsible_user_ids no pedido, a resposta NÃO ganha responsaveis e a RPC não recebe a chave", async () => {
    const resposta = await alterarAgendamentoHandler(supabaseFake(), ctx, { id: COMPROMISSO, title: "Outro título" } as never);
    expect(resposta).not.toHaveProperty("responsaveis");
    expect(chamadasRpc[0]?.args.p_patch).not.toHaveProperty("responsible_user_ids");
    expect(vi.mocked(audit).mock.calls.some(([a]) => a.action === "agenda.appointment_responsibles_changed")).toBe(false);
  });

  it("a resposta lista o que o banco releu, não o que o pedido trouxe", async () => {
    estado.antes = [];
    estado.depois = [X];
    const resposta = await alterarAgendamentoHandler(supabaseFake(), ctx, {
      id: COMPROMISSO,
      responsible_user_ids: [X, Y],
    } as never);
    expect(resposta).toMatchObject({ responsaveis: [{ user_id: X }] });
  });

  it("emite agenda.appointment_responsibles_changed quando a lista muda de fato", async () => {
    estado.antes = [];
    estado.depois = [X];
    await alterarAgendamentoHandler(supabaseFake(), ctx, { id: COMPROMISSO, responsible_user_ids: [X] } as never);
    const auditoria = vi.mocked(audit).mock.calls.map(([a]) => a).filter((a) => a.action === "agenda.appointment_responsibles_changed");
    expect(auditoria).toHaveLength(1);
    expect(auditoria[0]).toMatchObject({ resourceId: COMPROMISSO, metadata: { responsaveis: [{ user_id: X }] } });
  });

  it("não emite auditoria quando a lista continua igual", async () => {
    estado.antes = [X];
    estado.depois = [X];
    await alterarAgendamentoHandler(supabaseFake(), ctx, { id: COMPROMISSO, responsible_user_ids: [X] } as never);
    expect(vi.mocked(audit).mock.calls.some(([a]) => a.action === "agenda.appointment_responsibles_changed")).toBe(false);
  });

  it("limpar a lista com [] devolve responsaveis vazio e audita a saída", async () => {
    estado.antes = [X];
    estado.depois = [];
    const resposta = await alterarAgendamentoHandler(supabaseFake(), ctx, { id: COMPROMISSO, responsible_user_ids: [] } as never);
    expect(resposta).toMatchObject({ responsaveis: [] });
    expect(vi.mocked(audit).mock.calls.some(([a]) => a.action === "agenda.appointment_responsibles_changed")).toBe(true);
  });

  it("falha de releitura depois do PATCH gravado vira 500 nomeado, não resposta inventada", async () => {
    estado.antes = [];
    estado.erroReleitura = true;
    await expect(
      alterarAgendamentoHandler(supabaseFake(), ctx, { id: COMPROMISSO, responsible_user_ids: [X] } as never),
    ).rejects.toMatchObject({ status: 500, code: "internal_error" });
  });
});

describe("PATCH de responsáveis — erro do banco vira o código nomeado", () => {
  it("ocupação de adicional vira 409 responsavel_indisponivel com o uuid", async () => {
    estado.erroRpc = { message: "responsible_unavailable", code: "PT409", details: X };
    const erro = await alterarAgendamentoHandler(supabaseFake(), ctx, { id: COMPROMISSO, responsible_user_ids: [X] } as never).catch((e) => e);
    expect(erro).toBeInstanceOf(ApiError);
    expect(erro).toMatchObject({ status: 409, code: "responsavel_indisponivel", details: { user_id: X } });
  });

  it("teto de adicionais vira 422 agenda_responsaveis_teto, e não o 422 genérico validation_failed", async () => {
    estado.erroRpc = { message: "appointment_responsibles_limit", code: "22023" };
    const erro = await alterarAgendamentoHandler(supabaseFake(), ctx, { id: COMPROMISSO, responsible_user_ids: [X] } as never).catch((e) => e);
    expect(erro).toMatchObject({ status: 422, code: "agenda_responsaveis_teto" });
  });

  it("conflito de equipe da sessão coletiva vira 409 service_team_conflict", async () => {
    estado.erroRpc = { message: "service_team_conflict", code: "PT409" };
    const erro = await alterarAgendamentoHandler(supabaseFake(), ctx, { id: COMPROMISSO, responsible_user_ids: [X] } as never).catch((e) => e);
    expect(erro).toMatchObject({ status: 409, code: "service_team_conflict" });
  });
});

/**
 * CRIAÇÃO SEM SERVIÇO — o ramo escolhido pelo número de responsáveis.
 * Sem responsáveis, a criação é o INSERT de sempre (e o RPC nem é chamado).
 * Com responsáveis, a gravação vai ao RPC numa transação só.
 */
describe("criação sem serviço — o ramo depende de haver responsáveis", () => {
  const chamadasInsert: Array<Record<string, unknown>> = [];
  const chamadasRpcCriacao: Array<{ fn: string; args: Record<string, unknown> }> = [];
  let erroRpcCriacao: { message: string; code?: string; details?: string | null } | null = null;
  let chaveDosColegasCriacao = true;

  function supabaseCriacao(): SupabaseClient {
    const cadeia = (tabela: string) => {
      const c: Record<string, unknown> = {};
      for (const m of ["eq", "neq", "in", "is", "or", "order", "limit", "not", "gt", "lt", "gte", "lte"]) {
        c[m] = () => c;
      }
      c.select = () => c;
      const resolve = async (): Promise<{ data: unknown; error: unknown }> => {
        if (tabela === "calendar_event_types") {
          return {
            data: {
              id: TIPO,
              name: "Consulta",
              is_active: true,
              duration_minutes: 60,
              default_owner_user_id: null,
              requires_confirmation: false,
              location_kind: "none",
              location_details: null,
              service_enabled: false,
              external_provider: null,
            },
            error: null,
          };
        }
        if (tabela === "user_organizations") {
          return { data: [{ user_id: X }, { user_id: Y }], error: null };
        }
        return { data: [], error: null };
      };
      c.maybeSingle = resolve;
      c.single = resolve;
      c.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => resolve().then(ok, ko);
      return c;
    };
    return {
      from: (tabela: string) => ({
        ...cadeia(tabela),
        insert: (linha: Record<string, unknown>) => {
          chamadasInsert.push(linha);
          const linhaGravada = {
            id: COMPROMISSO,
            starts_at: "2026-12-01T14:00:00.000Z",
            ends_at: "2026-12-01T15:00:00.000Z",
            status: "confirmed",
            time_zone: "America/Sao_Paulo",
            revision: 1,
            meeting_state: null,
            meeting_url: null,
          };
          return { select: () => ({ single: async () => ({ data: linhaGravada, error: null }) }) };
        },
      }),
      rpc: async (fn: string, args: Record<string, unknown>) => {
        chamadasRpcCriacao.push({ fn, args });
        if (fn === "fn_colegas_podem_mexer_na_agenda") return { data: chaveDosColegasCriacao, error: null };
        if (fn !== "fn_appointment_insert_with_responsibles") return { data: [], error: null };
        if (erroRpcCriacao) return { data: null, error: erroRpcCriacao };
        return { data: { id: COMPROMISSO }, error: null };
      },
    } as unknown as SupabaseClient;
  }

  const entrada = { event_type_id: TIPO, starts_at: "2026-12-01T14:00:00.000Z", owner_user_id: PRINCIPAL };

  beforeEach(() => {
    chamadasInsert.length = 0;
    chamadasRpcCriacao.length = 0;
    erroRpcCriacao = null;
    chaveDosColegasCriacao = true;
  });

  // #5280: o adicional ocupa a agenda do colega, então segue a opção do principal.
  const atendenteDono = { ...ctx, actor: { type: "user", id: PRINCIPAL, role: "agent" } } as unknown as HandlerCtx;

  it("(c) atendente com a opção desligada incluindo um colega: 403 appointment_do_colega e nada gravado", async () => {
    chaveDosColegasCriacao = false;
    const erro = await marcarAgendamentoHandler(supabaseCriacao(), atendenteDono, {
      ...entrada,
      responsible_user_ids: [X],
    } as never).catch((e) => e);
    expect(erro).toBeInstanceOf(ApiError);
    expect(erro).toMatchObject({ status: 403, code: "appointment_do_colega" });
    expect(chamadasInsert).toHaveLength(0);
    expect(chamadasRpcCriacao.filter((c) => c.fn === "fn_appointment_insert_with_responsibles")).toHaveLength(0);
  });

  it("(d) controle: com a opção ligada, o mesmo pedido chega ao RPC", async () => {
    await marcarAgendamentoHandler(supabaseCriacao(), atendenteDono, { ...entrada, responsible_user_ids: [X] } as never).catch(() => null);
    expect(chamadasRpcCriacao.filter((c) => c.fn === "fn_appointment_insert_with_responsibles")).toHaveLength(1);
  });

  it("(a) SEM responsible_user_ids: chama o INSERT de sempre e NÃO chama o RPC", async () => {
    // O que vem depois do INSERT (laço, automação) não é o foco deste caso; a falha lá
    // não muda o que se prova aqui, que é qual gravação foi feita.
    const erroA = await marcarAgendamentoHandler(supabaseCriacao(), ctx, { ...entrada } as never).catch((e) => e);
    expect(chamadasInsert, `erro após o INSERT ou antes: ${String(erroA)}`).toHaveLength(1);
    expect(chamadasRpcCriacao.filter((c) => c.fn === "fn_appointment_insert_with_responsibles")).toHaveLength(0);
  });

  it("(b) COM responsáveis: chama o RPC com p_responsibles e p_f.id, e responsible_unavailable vira 409", async () => {
    erroRpcCriacao = { message: "responsible_unavailable", code: "PT409", details: X };
    const erro = await marcarAgendamentoHandler(supabaseCriacao(), ctx, {
      ...entrada,
      responsible_user_ids: [X],
    } as never).catch((e) => e);
    expect(chamadasInsert).toHaveLength(0);
    const rpcDeCriacao = chamadasRpcCriacao.filter((c) => c.fn === "fn_appointment_insert_with_responsibles");
    expect(rpcDeCriacao).toHaveLength(1);
    expect(rpcDeCriacao[0]?.args.p_responsibles).toEqual([X]);
    const pF = rpcDeCriacao[0]?.args.p_f as Record<string, unknown>;
    expect(typeof pF.id).toBe("string");
    expect(pF.id).not.toBe("");
    expect(erro).toBeInstanceOf(ApiError);
    expect(erro).toMatchObject({ status: 409, code: "responsavel_indisponivel", details: { user_id: X } });
  });
});

describe("PATCH de responsáveis — a opção de agenda dos colegas vale para os adicionais (#5280)", () => {
  // O atendente é o DONO do compromisso: a recusa que se mede é a do adicional, não a do principal.
  const atendenteDono = { ...ctx, actor: { type: "user", id: PRINCIPAL, role: "agent" } } as unknown as HandlerCtx;
  const gerente = { ...ctx, actor: { type: "user", id: USUARIO, role: "manager" } } as unknown as HandlerCtx;

  it("opção desligada: o atendente que põe um colega na lista recebe 403 appointment_do_colega e a RPC de mudança não é chamada", async () => {
    estado.chaveDosColegas = false;
    const erro = await alterarAgendamentoHandler(supabaseFake(), atendenteDono, { id: COMPROMISSO, responsible_user_ids: [X] } as never).catch((e) => e);
    expect(erro).toBeInstanceOf(ApiError);
    expect(erro).toMatchObject({ status: 403, code: "appointment_do_colega" });
    expect(chamadasRpc.some((c) => c.fn === "fn_appointment_change")).toBe(false);
  });

  it("opção desligada: tirar todos os adicionais ([]) segue permitido", async () => {
    estado.chaveDosColegas = false;
    estado.antes = [X];
    await alterarAgendamentoHandler(supabaseFake(), atendenteDono, { id: COMPROMISSO, responsible_user_ids: [] } as never);
    expect(chamadasRpc.some((c) => c.fn === "fn_appointment_change")).toBe(true);
  });

  it("controles: com a opção ligada o atendente passa; o gerente passa com ela desligada", async () => {
    await alterarAgendamentoHandler(supabaseFake(), atendenteDono, { id: COMPROMISSO, responsible_user_ids: [X] } as never);
    expect(chamadasRpc.filter((c) => c.fn === "fn_appointment_change")).toHaveLength(1);
    estado.chaveDosColegas = false;
    await alterarAgendamentoHandler(supabaseFake(), gerente, { id: COMPROMISSO, responsible_user_ids: [X] } as never);
    expect(chamadasRpc.filter((c) => c.fn === "fn_appointment_change")).toHaveLength(2);
  });
});
