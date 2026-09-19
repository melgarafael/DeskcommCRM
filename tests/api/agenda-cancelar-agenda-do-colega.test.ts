import { beforeEach, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({ audit: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: deps.audit }));

import {
  alterarAgendamentoHandler,
  cancelarAgendamentoHandler,
} from "@/app/api/v1/agenda/agendamentos/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * A AGENDA DO COLEGA, NA ROTA — as duas posições da opção e os papéis.
 *
 * A decisão do mantenedor na issue #978 (16/09) é uma OPÇÃO POR ORGANIZAÇÃO,
 * LIGADA POR PADRÃO, e o defeito que este arquivo vigia é o de sempre nesta
 * base: uma regra que existe no banco e não existe na rota (ou o contrário).
 * Aqui a prova é de COMPORTAMENTO, no handler que a rota e as ferramentas MCP
 * chamam — não de texto: o que se mede é a escrita que aconteceu (ou não) e o
 * desfecho que quem pediu recebe.
 *
 * ─── O que cada caso fixa ────────────────────────────────────────────────────
 *
 *   `AGENTE` com o compromisso de OUTRA pessoa e a opção DESLIGADA é o caso da
 *   issue: tem de ser recusado, e recusado SEM tocar no banco.
 *
 *   `AGENTE` no compromisso DELE com a opção desligada continua podendo — a
 *   regra recorta por dono, não proíbe a agenda própria.
 *
 *   `GERENTE` e `ADMINISTRADOR` no compromisso de outra pessoa com a opção
 *   desligada continuam podendo: a decisão diz "Gerente e Administrador seguem
 *   podendo tudo", e uma recusa aqui seria a migration fazendo mais do que foi
 *   decidido.
 *
 *   `AGENTE` com a opção LIGADA é o estado de quem já instalou: nada mudou.
 *
 *   `ai_agent` com a opção desligada passa: IA e integração não são "um
 *   atendente" e não têm agenda própria — o escopo delas é declarado no PR da
 *   issue, e inventar recorte por dono aqui seria mudar o que ninguém decidiu.
 */

const ORG = "00000000-0000-4000-8000-000000000001";
const DONO = "00000000-0000-4000-8000-0000000000aa";
const OUTRO = "00000000-0000-4000-8000-0000000000bb";
const COMPROMISSO = "00000000-0000-4000-8000-0000000000cc";

const linhaDoCompromisso = (owner: string | null) => ({
  id: COMPROMISSO,
  revision: 3,
  owner_user_id: owner,
  // Sem contato de propósito: o caminho do LACOTE (timeline do lead, automação
  // por negócio) fica de fora, e o que o teste mede é a decisão e a escrita.
  contact_id: null,
  event_type_id: null,
  status: "confirmed",
  time_zone: "America/Sao_Paulo",
});

/**
 * O cliente falso registra TODA chamada: é assim que o teste prova que a
 * recusa acontece ANTES da escrita (`fn_appointment_change` não aparece), e não
 * depois dela.
 */
function sbDeTeste(linha: Record<string, unknown>, opcaoLigada: boolean | null, chamadas: string[]) {
  const api = {
    from(tabela: string) {
      chamadas.push(`from:${tabela}`);
      const q = {
        select: () => q,
        eq: () => q,
        is: () => q,
        order: () => q,
        limit: () => q,
        maybeSingle: async () => ({
          data: tabela === "calendar_appointments" ? linha : { name: "Consulta" },
          error: null,
        }),
        single: async () => ({ data: linha, error: null }),
        insert: () => q,
        update: () => q,
        delete: () => q,
      };
      return q;
    },
    async rpc(nome: string, args: { p_patch?: { status?: string } }) {
      chamadas.push(`rpc:${nome}`);
      if (nome === "fn_colegas_podem_mexer_na_agenda") return { data: opcaoLigada, error: null };
      if (nome === "fn_appointment_change") {
        return { data: { ...linha, status: args?.p_patch?.status ?? linha.status }, error: null };
      }
      return { data: null, error: null };
    },
  };
  return api as unknown as SupabaseClient;
}

const ctxDe = (papel: string, quem = DONO): HandlerCtx =>
  ({
    organization_id: ORG,
    requestId: "req-978",
    actor: { type: "user", id: quem, role: papel },
  }) as unknown as HandlerCtx;

const ctxDaIA = (): HandlerCtx =>
  ({
    organization_id: ORG,
    requestId: "req-978",
    actor: { type: "ai_agent", id: "run-1", role: "agent" },
  }) as unknown as HandlerCtx;

const cancelamento = { id: COMPROMISSO, revision: 3, reason: "cliente desmarcou" };

beforeEach(() => {
  vi.resetAllMocks();
});

it("Atendente no compromisso de um colega, opção desligada: recusa SEM escrita", async () => {
  const chamadas: string[] = [];
  const sb = sbDeTeste(linhaDoCompromisso(DONO), false, chamadas);

  await expect(cancelarAgendamentoHandler(sb, ctxDe("agent", OUTRO), cancelamento)).rejects.toMatchObject(
    { status: 403, code: "appointment_do_colega" },
  );

  // A prova que importa: nada foi escrito e nada foi auditado.
  expect(chamadas).not.toContain("rpc:fn_appointment_change");
  expect(deps.audit).not.toHaveBeenCalled();
});

it("Atendente no PRÓPRIO compromisso, opção desligada: cancela", async () => {
  const chamadas: string[] = [];
  const sb = sbDeTeste(linhaDoCompromisso(DONO), false, chamadas);

  const salvo = await cancelarAgendamentoHandler(sb, ctxDe("agent", DONO), cancelamento);

  expect(salvo).toMatchObject({ id: COMPROMISSO, status: "cancelled" });
  expect(chamadas).toContain("rpc:fn_appointment_change");
  // O PRÓPRIO compromisso não consulta a opção: o dono é quem pede, e a opção só
  // é lida onde ela pode recortar — no compromisso de TERCEIRO (o caso anterior).
  expect(chamadas).not.toContain("rpc:fn_colegas_podem_mexer_na_agenda");
});

it("Gerente no compromisso de um colega, opção desligada: cancela", async () => {
  const chamadas: string[] = [];
  const sb = sbDeTeste(linhaDoCompromisso(DONO), false, chamadas);

  const salvo = await cancelarAgendamentoHandler(sb, ctxDe("manager", OUTRO), cancelamento);

  expect(salvo).toMatchObject({ status: "cancelled" });
  expect(chamadas).toContain("rpc:fn_appointment_change");
});

it("Administrador no compromisso de um colega, opção desligada: cancela", async () => {
  const chamadas: string[] = [];
  const sb = sbDeTeste(linhaDoCompromisso(DONO), false, chamadas);

  const salvo = await cancelarAgendamentoHandler(sb, ctxDe("admin", OUTRO), cancelamento);

  expect(salvo).toMatchObject({ status: "cancelled" });
  expect(chamadas).toContain("rpc:fn_appointment_change");
});

it("Atendente no compromisso de um colega, opção LIGADA: cancela como sempre", async () => {
  const chamadas: string[] = [];
  const sb = sbDeTeste(linhaDoCompromisso(DONO), true, chamadas);

  const salvo = await cancelarAgendamentoHandler(sb, ctxDe("agent", OUTRO), cancelamento);

  expect(salvo).toMatchObject({ status: "cancelled" });
  expect(chamadas).toContain("rpc:fn_appointment_change");
});

it("Compromisso SEM dono, opção desligada: o Atendente não mexe, o Gerente sim", async () => {
  const chamadasDoAgente: string[] = [];
  await expect(
    cancelarAgendamentoHandler(
      sbDeTeste(linhaDoCompromisso(null), false, chamadasDoAgente),
      ctxDe("agent", OUTRO),
      cancelamento,
    ),
  ).rejects.toMatchObject({ status: 403, code: "appointment_do_colega" });
  expect(chamadasDoAgente).not.toContain("rpc:fn_appointment_change");

  const chamadasDoGerente: string[] = [];
  await expect(
    cancelarAgendamentoHandler(
      sbDeTeste(linhaDoCompromisso(null), false, chamadasDoGerente),
      ctxDe("manager", OUTRO),
      cancelamento,
    ),
  ).resolves.toMatchObject({ status: "cancelled" });
});

it("IA no compromisso de um colega, opção desligada: passa (não é um atendente)", async () => {
  // Escopo DECLARADO no PR: a opção é sobre gente com agenda própria. Se um dia
  // o mantenedor decidir recortar também IA e integração, este caso muda de
  // propósito — e é ele que obriga a decisão a ser explícita.
  const chamadas: string[] = [];
  const sb = sbDeTeste(linhaDoCompromisso(DONO), false, chamadas);

  const salvo = await cancelarAgendamentoHandler(sb, ctxDaIA(), cancelamento);

  expect(salvo).toMatchObject({ status: "cancelled" });
  expect(chamadas).toContain("rpc:fn_appointment_change");
});

/**
 * ─── O MESMO RECORTE NA REMARCAÇÃO (`alterarAgendamentoHandler`) ─────────────
 *
 * A issue #978 é literal: "qualquer Atendente cancela ou REMARCA o compromisso
 * de qualquer colega". Os dois handlers usam a MESMA função
 * (`exigeDonoDoCompromisso`) — e é justamente por serem dois lugares que a
 * guarda volta a faltar num deles sem ninguém ver. Aqui a remarcação é
 * exercitada pelo caminho em que a recusa tem de vencer ANTES de qualquer
 * consulta de grade: com a opção desligada e o compromisso de outro, a recusa
 * sai em `exigeDonoDoCompromisso` e `fn_appointment_change` não é chamada.
 */

const NOVO_INICIO = "2026-09-21T13:00:00.000Z";

it("Atendente REMARCANDO o compromisso de um colega, opção desligada: recusa SEM escrita", async () => {
  const chamadas: string[] = [];
  const sb = sbDeTeste(linhaDoCompromisso(OUTRO), false, chamadas);

  await expect(
    alterarAgendamentoHandler(sb, ctxDe("agent", DONO), {
      id: COMPROMISSO,
      revision: 3,
      starts_at: NOVO_INICIO,
    }),
  ).rejects.toMatchObject({ status: 403, code: "appointment_do_colega" });

  expect(chamadas).not.toContain("rpc:fn_appointment_change");
  expect(deps.audit).not.toHaveBeenCalled();
});

it("Atendente no compromisso de um colega, opção LIGADA: altera como sempre", async () => {
  const chamadas: string[] = [];
  const sb = sbDeTeste(linhaDoCompromisso(OUTRO), true, chamadas);

  const salvo = await alterarAgendamentoHandler(sb, ctxDe("agent", DONO), {
    id: COMPROMISSO,
    revision: 3,
    notes: "anotar o portão de entrada",
  });

  expect(salvo).toBeTruthy();
  expect(chamadas).toContain("rpc:fn_appointment_change");
});

it("Gerente alterando o compromisso de um colega, opção desligada: passa", async () => {
  const chamadas: string[] = [];
  const sb = sbDeTeste(linhaDoCompromisso(OUTRO), false, chamadas);

  const salvo = await alterarAgendamentoHandler(sb, ctxDe("manager", DONO), {
    id: COMPROMISSO,
    revision: 3,
    notes: "encaixe combinado por telefone",
  });

  expect(salvo).toBeTruthy();
  expect(chamadas).toContain("rpc:fn_appointment_change");
});
