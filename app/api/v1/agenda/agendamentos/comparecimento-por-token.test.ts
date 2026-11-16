/**
 * #4515 — O DESFECHO DO COMPROMISSO POR TOKEN DE API, MEDIDO NA ROTA.
 *
 * ## O que estava quebrado
 *
 * `completed` e `no_show` respondem "a pessoa veio?". Até aqui a resposta só
 * entrava por sessão de navegador: o handler recusava qualquer ator que não
 * fosse `user`, e o banco recusava de novo (`appointment_human_confirmation_required`)
 * todo update de desfecho sem `auth.uid()`. Resultado na vida real: quem tem app
 * próprio integrado por token não fecha o compromisso, o CRM segue com ele
 * "confirmado" depois do horário e o fluxo de follow-up de falta
 * (`appointment_no_show`) nunca é alcançado por integração nenhuma.
 *
 * ## O que este arquivo prova, e onde
 *
 * Na ROTA e no HANDLER de verdade (`despachar` -> `alterarAgendamentoHandler`),
 * contra um dublê do Supabase que só devolve a linha quando a consulta filtra a
 * organização dona dela:
 *
 *  1. token com `agenda:attendance` marca REALIZADO;
 *  2. token com o escopo marca NÃO COMPARECEU e o caminho do gatilho é o mesmo
 *     da tela: `fn_appointment_record_attendance` -> `fn_appointment_change`
 *     (o status que o carimbo do banco lê) + `appointment.no_show` no
 *     `event_log` do laço de retorno;
 *  3. token SEM o escopo leva 403 nomeando `agenda:attendance` e NADA é escrito;
 *  4. a sessão de navegador continua marcando — controle, sem escopo nenhum;
 *  5. compromisso de OUTRA organização não é alcançável (404) — e o dublê
 *     devolveria a linha se a consulta perdesse o filtro de organização.
 *
 * ⚠️ O gatilho de follow-up `appointment_no_show` nasce no BANCO, de
 * `appointment.outcome_confirmed`, emitido por `fn_appointment_change_core`
 * quando o status vira `no_show` com `outcome_recorded_at` preenchido. Essa
 * perna é a mesma para a tela e para o token (mesma função, mesmo status) e
 * está coberta por `tests/invariants/agenda-presenca-recuperacao.test.ts`; aqui
 * a sonda cobre a perna que o token acrescenta: a escrita entrar pelo RPC que
 * carimba o desfecho.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { requireRole } from "@/lib/auth/require-role";
import { ALVO_DE_VINCULO_DO_AGENDAMENTO } from "@/lib/agenda/tipos";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined), isServiceRoleConfigured: vi.fn(() => true) }));
vi.mock("@/lib/mcp/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mcp/auth")>("@/lib/mcp/auth");
  return { ...actual, validateBearerToken: vi.fn() };
});

const { validateBearerToken, deriveActor } = await import("@/lib/mcp/auth");
const { PATCH } = await import("./route");
const { audit } = await import("@/lib/audit");

const ORG = "aaaaaaaa-0000-4000-8000-00000000000a";
const OUTRA_ORG = "bbbbbbbb-0000-4000-8000-00000000000b";
const USUARIO = "cccccccc-0000-4000-8000-00000000000c";
const TOKEN = "dddddddd-0000-4000-8000-00000000000d";
const TIPO = "eeeeeeee-0000-4000-8000-00000000000e";
const CONTATO = "ffffffff-0000-4000-8000-00000000000f";
const NEGOCIO = "11111111-0000-4000-8000-000000000011";
const AGENDAMENTO = "22222222-0000-4000-8000-000000000022";
// `role:admin`: a rota cobra `ai_operator` do token (o mesmo rank das tools de
// escrita da agenda), e o token de integração nasce com o papel que quem emitiu
// escolheu na tela. O escopo do desfecho é o que este arquivo varia.
const TOKEN_COM_ESCOPO = ["mcp:write", "role:admin", "agenda:attendance"];
const TOKEN_SEM_ESCOPO = ["mcp:write", "role:admin"];

type Linha = Record<string, unknown>;

/** O que chegou ao dublê. Fixture e sonda no mesmo objeto. */
interface Banco {
  agendamento: Linha;
  negocios: Linha[];
  inserido: Record<string, Linha[]>;
  rpc: Array<{ fn: string; args: Linha }>;
  /** `[coluna, valor]` de cada `eq` da leitura — é o que prova o filtro de org. */
  filtros: Array<[string, unknown]>;
}

let banco: Banco;

/**
 * O dublê do Supabase.
 *
 * `maybeSingle` de `calendar_appointments` só devolve a linha quando a consulta
 * filtra `organization_id` igual ao DONO dela. Sem isso, o caso 5 passaria a
 * verde no dia em que alguém apagasse o `.eq("organization_id", ...)` de
 * `exigeAgendamento` — que é exatamente o defeito que ele cerca.
 */
function cliente(): SupabaseClient {
  const leitura = (tabela: string) => {
    const cadeia: Record<string, unknown> = {};
    for (const m of ["eq", "neq", "in", "is", "not", "or", "gte", "lte", "lt", "gt", "order", "limit"]) {
      cadeia[m] = (coluna?: string, valor?: unknown) => {
        if (m === "eq" && typeof coluna === "string") banco.filtros.push([coluna, valor]);
        return cadeia;
      };
    }
    const resposta = () => {
      if (tabela === "crm_leads") return { data: banco.negocios, error: null };
      if (tabela === "crm_lead_links") {
        return {
          data: [{ lead_id: NEGOCIO, target_kind: ALVO_DE_VINCULO_DO_AGENDAMENTO, target_id: AGENDAMENTO }],
          error: null,
        };
      }
      if (tabela === "contacts") return { data: { id: CONTATO, organization_id: ORG }, error: null };
      if (tabela === "calendar_event_types") {
        return { data: { id: TIPO, name: "Consulta", duration_minutes: 30, is_active: true }, error: null };
      }
      return { data: [], error: null };
    };
    // ⚠️ Avaliado na CHAMADA de `maybeSingle`, nunca na criação da cadeia: o
    // `.eq()` só acontece depois, e uma checagem antecipada devolveria "sem
    // filtro" para toda consulta — o teste passaria a acusar 404 sempre.
    //
    // O dublê imita o banco, não o desejo: SEM filtro de organização a linha
    // aparece (é o que o service-role faz de verdade, porque a RLS não vale), e
    // COM filtro de outra organização ela some. É essa assimetria que dá dentes
    // ao caso 5 — e é o único lugar onde ele tem.
    const linhaDoAgendamento = () => {
      if (tabela !== "calendar_appointments") return { data: null, error: null };
      const filtrosDeOrg = banco.filtros.filter(([c]) => c === "organization_id");
      const alcanca =
        filtrosDeOrg.length === 0 ||
        filtrosDeOrg.some(([, v]) => v === banco.agendamento.organization_id);
      return alcanca
        ? { data: banco.agendamento, error: null }
        : { data: null, error: null };
    };

    cadeia.select = () => cadeia;
    cadeia.maybeSingle = async () => (tabela === "calendar_appointments" ? linhaDoAgendamento() : resposta());
    cadeia.single = async () => linhaDoAgendamento();
    // `then` é a leitura em lista: `calendar_appointments` como lista é a
    // ocupação (array), nunca a linha solta.
    cadeia.then = (r: (v: unknown) => unknown) => r(tabela === "calendar_appointments" ? { data: [banco.agendamento], error: null } : resposta());
    return cadeia;
  };

  return {
    from: (tabela: string) => ({
      select: () => leitura(tabela),
      insert: (linha: Linha) => {
        (banco.inserido[tabela] ??= []).push(linha);
        const resposta = { data: banco.agendamento, error: null };
        return {
          select: () => ({ single: async () => resposta, maybeSingle: async () => resposta }),
          then: (r: (v: unknown) => unknown) => r(resposta),
        };
      },
      update: (patch: Linha) => {
        const cadeia: Record<string, unknown> = {};
        const resposta = () => ({ data: { ...banco.agendamento, ...patch }, error: null });
        for (const m of ["eq", "in", "is"]) cadeia[m] = () => cadeia;
        cadeia.select = () => cadeia;
        cadeia.single = async () => resposta();
        cadeia.then = (r: (v: unknown) => unknown) => r(resposta());
        return cadeia;
      },
    }),
    rpc: async (fn: string, args: Linha) => {
      banco.rpc.push({ fn, args });
      const patch = (args.p_patch ?? {}) as Linha;
      if (fn === "fn_appointment_change") {
        // O carimbo do banco: status de desfecho sai com autoria e
        // `outcome_recorded_at` preenchido (é o que `fn_appointment_change_core`
        // usa para emitir `appointment.outcome_confirmed`).
        const desfecho = patch.status === "completed" || patch.status === "no_show";
        return {
          data: {
            ...banco.agendamento,
            ...patch,
            revision: 3,
            ...(desfecho ? { outcome_source_kind: "user", outcome_recorded_at: "2026-11-15T12:00:00.000Z" } : {}),
          },
          error: null,
        };
      }
      if (fn === "fn_appointment_record_attendance") {
        return {
          data: {
            ...banco.agendamento,
            ...patch,
            revision: 3,
            outcome_source_kind: "api_token",
            outcome_api_token_id: args.p_api_token,
            outcome_recorded_at: "2026-11-15T12:00:00.000Z",
          },
          error: null,
        };
      }
      return { data: null, error: null };
    },
  } as unknown as SupabaseClient;
}

function patchReq(body: unknown, headers?: HeadersInit): NextRequest {
  return new NextRequest("http://localhost/api/v1/agenda/agendamentos", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });
}

function comToken(escopos: string[]): HeadersInit {
  return { authorization: "Bearer dsk_teste_nao_e_token_real" };
}

/** O mesmo `deriveActor` do servidor: token sem `actor:ai_agent` é `api_token`. */
function tokenValido(escopos: string[]) {
  return {
    organizationId: ORG,
    actor: deriveActor(escopos, TOKEN),
    apiTokenId: TOKEN,
    scopes: escopos,
    role: "admin" as const,
  };
}

/** As chamadas de escrita do desfecho que chegaram ao banco. */
function escritasDoDesfecho(): Array<{ fn: string; args: Linha }> {
  return banco.rpc.filter(
    (c) => c.fn === "fn_appointment_change" || c.fn === "fn_appointment_record_attendance",
  );
}

function avisosDeFalta(): Array<{ fn: string; args: Linha }> {
  return banco.rpc.filter((c) => c.fn === "emit_event" && c.args.p_event_type === "appointment.no_show");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createClient).mockReturnValue(cliente() as never);
  vi.mocked(createAdminClient).mockReturnValue(cliente() as never);
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true, remaining: 99 } as never);
  banco = {
    agendamento: {
      id: AGENDAMENTO,
      organization_id: ORG,
      event_type_id: TIPO,
      owner_user_id: USUARIO,
      contact_id: CONTATO,
      // No PASSADO: o handler recusa desfecho antes do horário.
      starts_at: "2026-11-14T12:00:00.000Z",
      ends_at: "2026-11-14T12:30:00.000Z",
      status: "confirmed",
      revision: 2,
      time_zone: "America/Sao_Paulo",
    },
    negocios: [{ id: NEGOCIO, organization_id: ORG, title: "Consulta — Maria", status: "open" }],
    inserido: {},
    rpc: [],
    filtros: [],
  };
});

describe("#4515 — token marca comparecimento na agenda", () => {
  it("o token com `agenda:attendance` marca REALIZADO", async () => {
    vi.mocked(validateBearerToken).mockResolvedValue(tokenValido(TOKEN_COM_ESCOPO) as never);

    const resposta = await PATCH(
      patchReq({ id: AGENDAMENTO, revision: 2, status: "completed" }, comToken(TOKEN_COM_ESCOPO)),
    );

    expect(resposta.status, "o token com o escopo não conseguiu fechar o compromisso como realizado: a integração continua com o horário preso em 'confirmado' depois de acontecer").toBe(200);
    const corpo = (await resposta.json()) as Linha & { data?: Linha };
    const dados = (corpo.data ?? corpo) as Linha;
    expect(dados.status, "a rota respondeu 200 e não devolveu o status gravado: quem integra não tem como saber em que pé ficou").toBe("completed");

    const escritas = escritasDoDesfecho();
    expect(escritas, "a escrita não passou pelo RPC que carimba o desfecho: o banco recusa `completed` sem pessoa e a rota devolveria 422").toHaveLength(1);
    expect(escritas[0]!.fn).toBe("fn_appointment_record_attendance");
    expect(escritas[0]!.args.p_patch).toMatchObject({ status: "completed" });
    expect(
      escritas[0]!.args.p_api_token,
      "o id do token não chegou ao RPC: a linha não guarda QUAL integração registrou, e o audit fica sendo a única testemunha",
    ).toBe(TOKEN);
    expect(dados.outcome_api_token_id, "o desfecho voltou sem o token que o registrou").toBe(TOKEN);
    // A mutação audita QUAL token agiu, e não uma pessoa: sem isto o log diria
    // que ninguém registrou, e "a integração marcou" some do único lugar que
    // guarda o histórico da ação.
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "agenda.appointment_outcome_recorded",
        actorApiTokenId: TOKEN,
        actorUserId: null,
        organizationId: ORG,
        resourceId: AGENDAMENTO,
      }),
    );
  });

  it("o token marca NÃO COMPARECEU e o caminho do gatilho `appointment_no_show` é o mesmo da tela", async () => {
    vi.mocked(validateBearerToken).mockResolvedValue(tokenValido(TOKEN_COM_ESCOPO) as never);

    const resposta = await PATCH(
      patchReq({ id: AGENDAMENTO, revision: 2, status: "no_show" }, comToken(TOKEN_COM_ESCOPO)),
    );

    expect(resposta.status, "o token não conseguiu registrar a falta: o CRM segue gerando aviso de não comparecimento para atendimento que aconteceu — e o contrário, que é esta issue, fica impossível de corrigir por integração").toBe(200);
    const corpo = (await resposta.json()) as Linha & { data?: Linha };
    const dados = (corpo.data ?? corpo) as Linha;
    expect(dados.status).toBe("no_show");
    expect(
      dados.outcome_recorded_at,
      "o desfecho saiu sem `outcome_recorded_at`: é esse carimbo que o banco usa para emitir `appointment.outcome_confirmed`, o evento que alimenta o follow-up de falta",
    ).toBeTruthy();

    // A escrita é a MESMA do caminho humano: `fn_appointment_record_attendance`
    // confere o token e delega para `fn_appointment_change`, então o status chega
    // à mesma coluna que `fn_appointment_change_core` lê para emitir
    // `appointment.outcome_confirmed` -> `fn_appointment_recover`.
    const escritas = escritasDoDesfecho();
    expect(escritas).toHaveLength(1);
    expect(escritas[0]!.fn, "a falta foi gravada por fora da função que dispara o evento de recuperação: o follow-up de falta nunca saberia dela").toBe("fn_appointment_record_attendance");
    expect(escritas[0]!.args.p_patch).toMatchObject({ status: "no_show" });

    // E o laço de retorno avisa a automação da agenda com o nome do gatilho.
    expect(
      avisosDeFalta().length,
      "o `event_log` não recebeu `appointment.no_show`: as automações da agenda não reagem à falta registrada por token",
    ).toBeGreaterThan(0);
  });

  it("token SEM o escopo recebe 403 nomeando o escopo, e nada muda", async () => {
    vi.mocked(validateBearerToken).mockResolvedValue(tokenValido(TOKEN_SEM_ESCOPO) as never);

    const resposta = await PATCH(
      patchReq({ id: AGENDAMENTO, revision: 2, status: "no_show" }, comToken(TOKEN_SEM_ESCOPO)),
    );

    expect(resposta.status, "token sem `agenda:attendance` marcou presença: qualquer integração que já cria lead passaria a declarar quem faltou sem ninguém conceder isso").toBe(403);
    const corpo = (await resposta.json()) as { error?: { code?: string; message?: string } };
    expect(corpo.error?.code).toBe("forbidden_role");
    expect(
      String(corpo.error?.message),
      "o 403 não diz QUAL escopo falta: quem mantém a integração descobre o que pedir por chamado, não pela resposta",
    ).toContain("agenda:attendance");

    expect(escritasDoDesfecho(), "a recusa veio DEPOIS da escrita: o compromisso mudou mesmo sem o escopo").toHaveLength(0);
    expect(banco.inserido, "a recusa ainda mexeu no banco").toEqual({});
  });

  it("a sessão de navegador continua marcando (controle)", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      user: { id: USUARIO, role: "admin" },
      org: { orgId: ORG },
    } as never);

    const resposta = await PATCH(patchReq({ id: AGENDAMENTO, revision: 2, status: "completed" }));

    expect(resposta.status, "a tela deixou de registrar presença: a mudança para token fechou o caminho de quem sempre pôde — e é o único que o produto anuncia").toBe(200);
    const escritas = escritasDoDesfecho();
    expect(escritas, "a sessão passou a escrever pelo RPC do token: o desfecho de uma pessoa ficaria carimbado com um token de API").toHaveLength(1);
    expect(escritas[0]!.fn, "a sessão deixou de usar `fn_appointment_change`").toBe("fn_appointment_change");
    expect(escritas[0]!.args.p_api_token).toBeUndefined();
  });

  it("compromisso de OUTRA organização é inalcançável", async () => {
    // O token é de OUTRA_ORG; a linha do dublê pertence a ORG. O dublê devolve a
    // linha em qualquer consulta que NÃO filtre a organização dona.
    vi.mocked(validateBearerToken).mockResolvedValue({
      ...tokenValido(TOKEN_COM_ESCOPO),
      organizationId: OUTRA_ORG,
      scopes: TOKEN_COM_ESCOPO,
    } as never);

    const resposta = await PATCH(
      patchReq({ id: AGENDAMENTO, revision: 2, status: "no_show" }, comToken(TOKEN_COM_ESCOPO)),
    );

    expect(resposta.status, "um token de fora alcançou (e marcou) o compromisso de outra empresa: é vazamento entre organizações, não só um 200 errado").toBe(404);
    expect(escritasDoDesfecho(), "a escrita aconteceu antes de provar que o compromisso é da organização do token").toHaveLength(0);
  });
});
