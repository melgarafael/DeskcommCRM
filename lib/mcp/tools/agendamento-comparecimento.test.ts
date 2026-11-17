/**
 * `crm_set_appointment_outcome` por TOKEN — a ferramenta MCP da #4515.
 *
 * O que este arquivo fixa, e por quê:
 *
 *  1. token com `agenda:attendance` registra e devolve o NEGÓCIO vinculado — quem
 *     chamou tem como escrever o resumo no card certo sem uma segunda busca;
 *  2. token sem o escopo recebe uma recusa que NOMEIA o escopo (o mesmo texto da
 *     rota): a integração conserta sozinha em vez de abrir chamado;
 *  3. o agente de IA continua recebendo `requer_confirmacao_humana` — a mudança
 *     não afrouxou o portão do modelo;
 *  4. compromisso inexistente ou de OUTRA organização devolve recusa de negócio
 *     com a explicação, nunca exceção que derruba o turno.
 *
 * A escrita em si (revisão otimista, carimbo do desfecho, evento de falta) não é
 * provada aqui: quem a prova é `app/api/v1/agenda/agendamentos/comparecimento-por-token.test.ts`,
 * contra o handler de verdade. Aqui a sonda é a TRADUÇÃO entre a ferramenta e o
 * handler — o ponto onde um escopo conferido no lugar errado passaria batido.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/types";

const deps = vi.hoisted(() => ({
  alterar: vi.fn(),
  negocios: vi.fn(),
}));

vi.mock("@/app/api/v1/agenda/agendamentos/_handler", () => ({
  marcarAgendamentoHandler: vi.fn(),
  horariosLivresHandler: vi.fn(),
  alterarAgendamentoHandler: deps.alterar,
  cancelarAgendamentoHandler: vi.fn(),
}));

// O vínculo do compromisso mora em módulo próprio (a tool não depende do arquivo
// inteiro do handler) — o dublê acompanha o módulo de verdade.
vi.mock("@/lib/agenda/negocios-do-compromisso", () => ({
  negociosDoCompromisso: deps.negocios,
}));

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: vi.fn(() => true),
}));

const { crmSetAppointmentOutcome } = await import("./agendamento");

const ORG = "11111111-1111-4111-8111-111111111111";
const OUTRA_ORG = "99999999-9999-4999-8999-999999999999";
const TOKEN = "22222222-2222-4222-8222-222222222222";
const AGENDAMENTO = "33333333-3333-4333-8333-333333333333";
const NEGOCIO = "44444444-4444-4444-8444-444444444444";

type Linha = Record<string, unknown>;

function ctx(actor: Linha, tokenScopes?: string[], organizationId = ORG) {
  return {
    supabase: {} as never,
    organizationId,
    actor,
    requestId: "req-4515",
    ...(tokenScopes ? { tokenScopes } : {}),
  } as never;
}

const TOKEN_COM_ESCOPO = { type: "api_token" as const, id: TOKEN };

function agendamentoGravado(status: string): Linha {
  return {
    id: AGENDAMENTO,
    status,
    starts_at: "2026-11-14T12:00:00.000Z",
    ends_at: "2026-11-14T12:30:00.000Z",
    time_zone: "America/Sao_Paulo",
    revision: 3,
    outcome_source_kind: "api_token",
    outcome_api_token_id: TOKEN,
    outcome_recorded_at: "2026-11-15T12:00:00.000Z",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  deps.alterar.mockResolvedValue(agendamentoGravado("completed"));
  deps.negocios.mockResolvedValue([{ id: NEGOCIO, titulo: "Consulta — Maria" }]);
});

describe("#4515 — crm_set_appointment_outcome por token", () => {
  it("token com o escopo registra e devolve o negócio vinculado", async () => {
    const saida = (await crmSetAppointmentOutcome.handler(
      { appointment_id: AGENDAMENTO, outcome: "completed" } as never,
      ctx(TOKEN_COM_ESCOPO, ["mcp:write", "role:admin", "agenda:attendance"]),
    )) as Linha;

    expect(saida.registrado, "a ferramenta recusou um token com o escopo: a integração que fechou o atendimento não consegue dizer isso ao CRM").toBe(true);
    expect((saida.negocio as Linha | null)?.id, "a resposta não disse de qual negócio é o compromisso: quem integra teria que buscar o vínculo por fora para escrever o resumo no card certo").toBe(NEGOCIO);

    const [, ctxDoHandler, patch] = deps.alterar.mock.calls[0]!;
    expect(
      (ctxDoHandler as Linha).escoposDoToken,
      "os escopos não chegaram ao handler: a decisão de quem pode registrar ficaria só na ferramenta, e a rota REST — que chama o mesmo handler — seguiria recusando o mesmo token",
    ).toEqual(["mcp:write", "role:admin", "agenda:attendance"]);
    expect(patch).toMatchObject({ id: AGENDAMENTO, status: "completed" });
  });

  it("token sem o escopo recebe recusa que NOMEIA o escopo, e o handler não roda", async () => {
    const saida = (await crmSetAppointmentOutcome.handler(
      { appointment_id: AGENDAMENTO, outcome: "no_show" } as never,
      ctx(TOKEN_COM_ESCOPO, ["mcp:write", "role:admin"]),
    )) as Linha & { mensagem: string };

    expect(saida.registrado, "token sem `agenda:attendance` marcou falta pela ferramenta: qualquer integração com `mcp:write` declara quem faltou sem ninguém conceder isso").toBe(false);
    expect(saida.motivo).toBe("escopo_ausente");
    expect(
      String(saida.mensagem),
      "a recusa não diz qual escopo falta: quem mantém a integração não tem como consertar sem falar com o suporte",
    ).toContain("agenda:attendance");
    expect(deps.alterar, "a ferramenta recusou DEPOIS de chamar o handler").not.toHaveBeenCalled();
  });

  it("o agente de IA continua propondo em vez de registrar", async () => {
    const saida = (await crmSetAppointmentOutcome.handler(
      { appointment_id: AGENDAMENTO, outcome: "completed" } as never,
      ctx({ type: "ai_agent", id: "run-1" }, ["mcp:write", "actor:ai_agent"]),
    )) as Linha;

    expect(saida.requer_confirmacao_humana, "o agente de IA passou a registrar presença: um texto interpretado por modelo viraria testemunha de que a pessoa veio").toBe(true);
    expect(saida.orientacao, "o agente não recebeu o que dizer à equipe").toBeTruthy();
    expect(deps.alterar).not.toHaveBeenCalled();
  });

  it("compromisso de outra organização (ou inexistente) devolve recusa de negócio com a explicação", async () => {
    deps.alterar.mockRejectedValue(
      new ApiError(404, "not_found", undefined, "req-4515", "Agendamento não encontrado."),
    );

    const saida = (await crmSetAppointmentOutcome.handler(
      { appointment_id: AGENDAMENTO, outcome: "no_show" } as never,
      ctx(TOKEN_COM_ESCOPO, ["mcp:write", "role:admin", "agenda:attendance"], OUTRA_ORG),
    )) as Linha & { mensagem: string };

    expect(saida.registrado, "a ferramenta devolveu registrado=true para compromisso que não é da organização do token").toBe(false);
    expect(saida.motivo).toBe("not_found");
    expect(
      String(saida.mensagem),
      "a recusa não distingue 'não existe' de 'é de outra empresa': o modelo insistiria tentando o mesmo id",
    ).toContain("outra organização");
  });
});
