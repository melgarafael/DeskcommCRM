import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { HandlerCtx } from "@/lib/api/handlers/types";

/**
 * O DESFECHO POR TOKEN (#4515) — a porta existe, e é a MESMA regra da tela.
 *
 * ─── O que estava quebrado ────────────────────────────────────────────────
 *
 * `alterarAgendamentoHandler` recusava `completed`/`no_show` de qualquer ator
 * que não fosse pessoa ("uma interpretação de texto não registra o fato"). O
 * motivo é bom e continua valendo para o agente — mas a recusa pegava TAMBÉM
 * o token de integração, que não interpreta nada: ele gravou o atendimento e
 * sabe se a pessoa veio. Medido no HEAD: `PATCH /api/v1/agenda/agendamentos`
 * com Bearer `dsk_…` e `status: "completed"` fechava em 403, e o CRM seguia
 * gerando aviso de não comparecimento para atendimento que aconteceu.
 *
 * ─── A cura é uma EXCEÇÃO NOMEADA, não a remoção da guarda ────────────────
 *
 * A exceção viaja no ctx (`desfechoPorToken`), nunca no corpo: a rota só a
 * marca depois de conferir o escopo `agenda:attendance` na linha do token, e a
 * tool MCP só depois de `exigeEscopoDoTokenDeIntegracao`. Campo no input
 * deixaria qualquer chamador se declarar autorizado — em especial o agente,
 * que é exatamente quem a recusa original queria parar.
 *
 * ─── O que este arquivo NÃO repete ────────────────────────────────────────
 *
 * A guarda do futuro já tem cerca própria
 * (`tests/unit/desfecho-de-agenda-e-sobre-o-passado.test.ts`, ator PESSOA). Aqui
 * ela aparece de novo com ator TOKEN, porque a pergunta é outra: a exceção
 * abriu um buraco na guarda? Abriu nada — `no_show` de amanhã pelo token
 * continua recusado, e nada é gravado.
 */
vi.mock("@/lib/agenda/consulta", async (original) => {
  const real = await original<typeof import("@/lib/agenda/consulta")>();
  return { ...real, horariosLivresDaOrg: vi.fn() };
});

const auditoria = vi.hoisted(() => ({ chamadas: [] as Record<string, unknown>[] }));
vi.mock("@/lib/audit", () => ({
  audit: (entrada: Record<string, unknown>) => {
    auditoria.chamadas.push(entrada);
    return Promise.resolve();
  },
}));

const { alterarAgendamentoHandler } = await import("@/app/api/v1/agenda/agendamentos/_handler");
const { ApiError } = await import("@/lib/api/types");

const ORG = "aaaaaaaa-4515-4000-8000-00000000000a";
const AGENDAMENTO = "ffffffff-4515-4000-8000-00000000000f";
const TOKEN = "99999999-4515-4000-8000-000000000099";

/** O ator que a rota monta para um Bearer `dsk_…` sem `actor:ai_agent`. */
const atorDoToken = { type: "api_token", id: TOKEN, organization_id: ORG } as const;

const ctxDoToken = (extra: Partial<HandlerCtx> = {}) =>
  ({
    organization_id: ORG,
    actor: atorDoToken,
    requestId: "req-4515",
    apiTokenId: TOKEN,
    ...extra,
  }) as unknown as HandlerCtx;

const DIA = 86_400_000;
let atualizado: Record<string, unknown> | null;

/** Dublê mínimo: só o que `exigeAgendamento` lê e o que o update grava. */
function clienteCom(startsAt: string, status: string): SupabaseClient {
  const linha = {
    id: AGENDAMENTO,
    revision: 1,
    event_type_id: "cccccccc-4515-4000-8000-00000000000c",
    owner_user_id: "dddddddd-4515-4000-8000-00000000000d",
    contact_id: "eeeeeeee-4515-4000-8000-00000000000e",
    starts_at: startsAt,
    status,
    time_zone: "America/Sao_Paulo",
  };
  const leitura = () => {
    const cadeia: Record<string, unknown> = {};
    for (const m of ["eq", "order", "limit", "in", "is", "not"]) cadeia[m] = () => cadeia;
    cadeia.maybeSingle = async () => ({ data: linha, error: null });
    cadeia.single = async () => ({ data: linha, error: null });
    return cadeia;
  };
  return {
    from: () => ({
      select: () => leitura(),
      update: (mudanca: Record<string, unknown>) => {
        atualizado = mudanca;
        const cadeia: Record<string, unknown> = {};
        for (const m of ["eq"]) cadeia[m] = () => cadeia;
        cadeia.select = () => cadeia;
        cadeia.single = async () => ({ data: { ...linha, ...mudanca }, error: null });
        return cadeia;
      },
      insert: () => ({ select: () => ({ single: async () => ({ data: {}, error: null }) }) }),
    }),
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name !== "fn_appointment_change") return { data: null, error: null };
      expect(args.p_org).toBe(ORG);
      expect(args.p_id).toBe(AGENDAMENTO);
      atualizado = args.p_patch as Record<string, unknown>;
      return { data: { ...linha, ...atualizado, revision: 2 }, error: null };
    },
  } as unknown as SupabaseClient;
}

/**
 * O dublê da ORGANIZAÇÃO ALHEIA: a consulta com `organization_id` não casa
 * linha nenhuma. É o que o PostgREST devolve para um id de outra casa — o
 * filtro explícito é o que separa uma organização da outra, porque pelo MCP o
 * client é service-role e a RLS não vale.
 */
function clienteSemLinha(): SupabaseClient {
  const cadeia: Record<string, unknown> = {};
  for (const m of ["eq", "order", "limit", "in", "is", "not"]) cadeia[m] = () => cadeia;
  cadeia.maybeSingle = async () => ({ data: null, error: null });
  cadeia.single = async () => ({ data: null, error: null });
  return {
    from: () => ({
      select: () => cadeia,
      update: () => {
        atualizado = {};
        return cadeia;
      },
      insert: () => ({ select: () => ({ single: async () => ({ data: {}, error: null }) }) }),
    }),
    rpc: async () => ({ data: null, error: null }),
  } as unknown as SupabaseClient;
}

beforeEach(() => {
  atualizado = null;
  auditoria.chamadas.length = 0;
});

describe("#4515 — o desfecho por token de integração", () => {
  it("o TOKEN sem `desfechoPorToken` continua recusado: a guarda do agente fica de pé", async () => {
    // A guarda original não foi removida — foi dada uma exceção NOMEADA. Quem
    // não passa pela borda (nem rota, nem tool) não ganha o poder de gravar.
    const ontem = new Date(Date.now() - DIA).toISOString();

    const erro = await alterarAgendamentoHandler(clienteCom(ontem, "confirmed"), ctxDoToken(), {
      id: AGENDAMENTO,
      status: "completed",
    }).catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(ApiError);
    expect((erro as InstanceType<typeof ApiError>).status).toBe(403);
    expect(atualizado).toBeNull();
  });

  it("o TOKEN com o escopo concedido grava o desfecho de um compromisso de ontem", async () => {
    // O caso da issue: a integração que registrou o atendimento. Sem isto o CRM
    // segue gerando aviso de não comparecimento para quem foi atendido.
    const ontem = new Date(Date.now() - DIA).toISOString();

    await alterarAgendamentoHandler(
      clienteCom(ontem, "confirmed"),
      ctxDoToken({ desfechoPorToken: true }),
      { id: AGENDAMENTO, status: "no_show" },
    );

    expect(atualizado).toMatchObject({ status: "no_show" });
  });

  it("o audit diz QUAL token agiu — não só 'alguém marcou'", async () => {
    // `actorUserId: null` + `actorApiTokenId: <linha do token>` é o rastro que
    // responde a pergunta da issue. Sem a coluna, o log diria que ninguém fez.
    const ontem = new Date(Date.now() - DIA).toISOString();

    await alterarAgendamentoHandler(
      clienteCom(ontem, "confirmed"),
      ctxDoToken({ desfechoPorToken: true }),
      { id: AGENDAMENTO, status: "completed" },
    );

    const doDesfecho = auditoria.chamadas.find(
      (c) => c.action === "agenda.appointment_outcome_recorded",
    );
    expect(doDesfecho).toBeDefined();
    expect(doDesfecho?.actorUserId).toBeNull();
    expect(doDesfecho?.actorApiTokenId).toBe(TOKEN);
    expect(doDesfecho?.metadata).toMatchObject({ via: "token" });
  });

  it("a exceção NÃO abre a guarda do futuro: `no_show` de amanhã pelo token é recusado", async () => {
    // Sabotagem que este caso pega: trocar a ordem das guardas (ou remover a
    // comparação com o relógio) deixa o token devolver horário ao pool de um
    // compromisso que a pessoa ainda espera.
    const amanha = new Date(Date.now() + DIA).toISOString();

    const erro = await alterarAgendamentoHandler(
      clienteCom(amanha, "confirmed"),
      ctxDoToken({ desfechoPorToken: true }),
      { id: AGENDAMENTO, status: "no_show" },
    ).catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(ApiError);
    expect((erro as InstanceType<typeof ApiError>).code).toBe("agenda_ainda_nao_aconteceu");
    expect(atualizado).toBeNull();
  });

  it("o token de uma organização não alcança o compromisso de outra", async () => {
    // Pelo MCP o client é service-role: `organization_id` explícito é a ÚNICA
    // coisa que separa uma casa da outra. Sem ele, o update casaria a linha.
    const erro = await alterarAgendamentoHandler(clienteSemLinha(), ctxDoToken({ desfechoPorToken: true }), {
      id: AGENDAMENTO,
      status: "completed",
    }).catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(ApiError);
    expect((erro as InstanceType<typeof ApiError>).status).toBe(404);
    expect(atualizado ?? null).toBeNull();
  });
});
