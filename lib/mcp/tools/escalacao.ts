/**
 * Handlers das capacidades de ESCALAÇÃO — o ciclo agente ↔ pessoa.
 *
 * Fachada fina (Decisão 4 do briefing IA 360): toda regra de negócio já existe e é
 * chamada daqui —
 *   - roster + elegibilidade → `lib/escalacao/atendentes.ts` (mesma função da rota
 *     `/api/v1/attendants/availability`, mesmo predicado do worker de roteamento);
 *   - leitura de chamados   → `lib/escalacao/chamados.ts` (mesma função das rotas
 *     `/api/v1/ai/cases`);
 *   - transições de chamado → `lib/agent-engine/agent/human-cases.ts` (a máquina de
 *     estados, atômica, sobre `pg`);
 *   - devolver o atendimento → `lib/escalacao/retomada.ts` (mesma função da rota
 *     `/api/v1/conversations/[id]/reactivate-bot`).
 * Nenhum SQL novo mora aqui. Se a IA e a pessoa operassem por regras diferentes, o
 * sistema mentiria para uma das duas.
 *
 * `organization_id` SEMPRE do `ctx` (fonte confiável), NUNCA do input — service
 * role bypassa RLS.
 *
 * As transições de chamado rodam sobre `pg.Pool` porque é onde a máquina de
 * estados vive (UPDATE condicional + INSERT dos eventos no MESMO statement).
 * Reimplementá-las em PostgREST daria dois donos para a mesma regra e perderia a
 * atomicidade — o mesmo motivo pelo qual `POST /ai/cases/[id]/reply` usa o pool.
 */
import { z } from "zod";

import {
  encerrarChamadoPeloAgente,
  registrarNotaDoAgente,
  type DesfechoDoChamado,
} from "@/lib/agent-engine/agent/human-cases";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { audit } from "@/lib/audit";
import { carregarRosterDeAtendimento, podeAssumirAgora } from "@/lib/escalacao/atendentes";
import { lerChamado, listarChamados } from "@/lib/escalacao/chamados";
import { lerContinuidadeHumana } from "@/lib/escalacao/continuidade";
import { devolverAtendimentoAoAgente } from "@/lib/escalacao/retomada";
import type { McpContext, McpToolDefinition } from "../types";
import { resolveUserNames } from "./_users";

/** Payload de auditoria a partir do ator do ctx (mesma forma de governance.ts). */
function actorAudit(ctx: McpContext): {
  actorUserId: string | null;
  metadataActor: Record<string, unknown>;
} {
  const actor = ctx.actor;
  if (actor.type === "user") {
    return { actorUserId: actor.id, metadataActor: { actor_type: "user" } };
  }
  return { actorUserId: null, metadataActor: { actor_type: actor.type, actor_id: actor.id } };
}

// ---------------------------------------------------------------------------
// crm_list_available_attendants
// ---------------------------------------------------------------------------

const atendentesInputShape = {
  /** true = só quem pode receber AGORA; false = o roster inteiro, com o motivo. */
  only_available: z.boolean().default(true),
};

export const crmListAvailableAttendants: McpToolDefinition<typeof atendentesInputShape> = {
  name: "crm_list_available_attendants",
  description:
    "Atendentes da org com is_available, capacity, current_load e can_take_now (disponível ∧ " +
    "com folga ∧ dentro do horário — mesmo predicado do worker de roteamento), mais `present` " +
    "e `last_signal_at`: se a pessoa está com a tela do CRM aberta agora. Presença é SÓ " +
    "informação — quem pode receber é o can_take_now. Use ANTES de escalar: com zero elegíveis " +
    "a conversa vai para a fila e pode não ser puxada. Cada linha traz `nome` (só o full_name, " +
    "mínimo LGPD) para a regra de roteamento citar gente e não UUID (issue #1539); sem e-mail nem telefone.",
  inputSchema: atendentesInputShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    const agora = new Date();
    const roster = await carregarRosterDeAtendimento(ctx.supabase, ctx.organizationId, agora);
    // Nome de quem atende (issue #1539): para a IA escrever uma regra de
    // roteamento no prompt ela precisa de GENTE, não de UUID. O helper expõe
    // SÓ `full_name` (mínimo LGPD do `team/assignable`) — nunca e-mail,
    // telefone ou o `user_metadata` inteiro.
    const nomes = await resolveUserNames(
      ctx.supabase,
      roster.map((a) => a.userId),
    );
    const linhas = roster.map((a) => ({
      user_id: a.userId,
      nome: nomes.get(a.userId) ?? null,
      role: a.papel,
      is_available: a.disponivel,
      capacity: a.capacidade,
      current_load: a.cargaAtual,
      can_take_now: podeAssumirAgora(a, agora),
      // Leitor declarado (issue #996): a IA passa a saber se há alguém de fato
      // na frente da tela. `present: false` NÃO tira ninguém da lista nem
      // impede a passagem — quem decide isso é `can_take_now`. Serve para
      // escolher o prazo que o agente promete ao cliente e para dizer a verdade
      // quando prometer atendimento imediato for exagero.
      present: a.presente,
      last_signal_at: a.ultimoSinalEm,
    }));
    const elegiveis = linhas.filter((l) => l.can_take_now);
    const presentes = elegiveis.filter((l) => l.present).length;
    return {
      attendants: input.only_available ? elegiveis : linhas,
      // O total elegível vai SEMPRE, mesmo com only_available=false: é o número
      // que decide se escalar agora faz sentido, e deixá-lo implícito na
      // contagem do array faria o modelo errar quando a lista vem filtrada.
      available_count: elegiveis.length,
      // Quantos dos elegíveis têm sinal de presença agora. `present` nunca
      // reduz `available_count`; este campo é o que permite ao agente medir o
      // próprio exagero ao prometer "uma pessoa vai te atender".
      present_count: presentes,
      total_count: linhas.length,
      next_action:
        elegiveis.length === 0
          ? "Ninguém pode assumir agora. Avise o cliente do prazo real em vez de prometer atendimento imediato."
          : presentes === 0
            ? "Há gente elegível, mas ninguém com a tela aberta agora: passe o atendimento se o prazo puder ser maior, e não prometa resposta imediata."
            : "Há gente disponível e com a tela aberta: pode passar o atendimento.",
    };
  },
};

// ---------------------------------------------------------------------------
// crm_list_human_cases
// ---------------------------------------------------------------------------

const listaChamadosInputShape = {
  state: z.enum(["abertos", "fechados"]).default("abertos"),
  limit: z.number().int().min(1).max(50).default(20),
};

export const crmListHumanCases: McpToolDefinition<typeof listaChamadosInputShape> = {
  name: "crm_list_human_cases",
  description:
    "Casos humanos da org por estado. 'abertos' = awaiting_human|awaiting_lead; 'fechados' = " +
    "resolved|escalated|cancelled. Devolve title, blocker, status, conversation_id e o nome do " +
    "contato. open_count é sempre o total de abertos, independente do filtro.",
  inputSchema: listaChamadosInputShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    const { chamados, abertos } = await listarChamados(ctx.supabase, ctx.organizationId, {
      estado: input.state,
      limite: input.limit,
      // `"todas"`, e não o recorte por atendente que a TELA aplica: `ctx.supabase`
      // é admin por contrato (o agente não é um usuário com sessão, e a org vem
      // do `ctx`, nunca do input). Recortar aqui faria o agente de IA enxergar
      // MENOS casos do que enxerga hoje — ele abriu esses casos e é quem
      // acompanha a fila inteira. A divergência com a tela é deliberada e está
      // declarada no tipo (`ConversasVisiveis`), não escondida num default.
      visiveisPara: "todas",
    });
    return { cases: chamados, open_count: abertos };
  },
};

// ---------------------------------------------------------------------------
// crm_get_human_case
// ---------------------------------------------------------------------------

const chamadoInputShape = {
  case_id: z.string().uuid(),
};

export const crmGetHumanCase: McpToolDefinition<typeof chamadoInputShape> = {
  name: "crm_get_human_case",
  description:
    "Detalhe de um caso humano + timeline completa (eventos com actor_kind, human_action e o " +
    "texto escrito). Inclui `human_continuity`: o resumo pronto do que a pessoa decidiu nesta " +
    "conversa — use ele para retomar sem pedir de novo o que já foi combinado.",
  inputSchema: chamadoInputShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    // `"todas"` pela mesma razão de `crm_list_human_cases`: cliente admin por
    // contrato, e um caso que o agente abriu não pode sumir para ele porque a
    // conversa não está atribuída a ninguém.
    const chamado = await lerChamado(ctx.supabase, ctx.organizationId, input.case_id, {
      visiveisPara: "todas",
    });
    if (!chamado) throw new Error("case_not_found");

    const continuidade = await lerContinuidadeHumana(
      ctx.supabase,
      ctx.organizationId,
      chamado.conversation_id,
    );
    return {
      ...chamado,
      human_continuity: {
        had_human_attendance: continuidade.houveAtendimentoHumano,
        summary: continuidade.resumo,
        pending_with_customer: continuidade.pendenciaComOCliente,
        decisions: continuidade.decisoes,
      },
    };
  },
};

// ---------------------------------------------------------------------------
// crm_add_case_note
// ---------------------------------------------------------------------------

const notaInputShape = {
  case_id: z.string().uuid(),
  note: z.string().trim().min(1).max(4000),
};

export const crmAddCaseNote: McpToolDefinition<typeof notaInputShape> = {
  name: "crm_add_case_note",
  description:
    "Registra no caso ABERTO o que aconteceu depois da abertura (kind='agent_noted', " +
    "actor_kind='agent'). Recusa caso já fechado ou de outra org. Escreva o FATO novo, não a " +
    "repetição do bloqueio — quem lê é o próximo atendente.",
  inputSchema: notaInputShape,
  category: "write",
  requiresRole: "agent",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const registrado = await registrarNotaDoAgente(
      getRequestPool(),
      ctx.organizationId,
      input.case_id,
      input.note,
    );
    if (!registrado) throw new Error("case_not_open");

    const a = actorAudit(ctx);
    await audit({
      action: "ai.case_noted_by_agent",
      actorUserId: a.actorUserId,
      actorApiTokenId: ctx.apiTokenId,
      organizationId: ctx.organizationId,
      resourceType: "agent_case",
      resourceId: input.case_id,
      requestId: ctx.requestId,
      metadata: { ...a.metadataActor, via: "mcp" },
    });

    return {
      case_id: input.case_id,
      recorded: true,
      next_action: "Registro salvo no chamado; o próximo atendente vai ler isto.",
    };
  },
};

// ---------------------------------------------------------------------------
// crm_close_human_case
// ---------------------------------------------------------------------------

const encerrarInputShape = {
  case_id: z.string().uuid(),
  /** 'resolvido' = o bloqueio foi superado; 'sem_necessidade' = deixou de fazer sentido. */
  outcome: z.enum(["resolvido", "sem_necessidade"]),
  note: z.string().trim().min(1).max(4000),
};

export const crmCloseHumanCase: McpToolDefinition<typeof encerrarInputShape> = {
  name: "crm_close_human_case",
  description:
    "Encerra um caso ABERTO com o desfecho registrado: 'resolvido' (status resolved) ou " +
    "'sem_necessidade' (status cancelled). Grava actor_kind='agent' — nunca se passa por " +
    "decisão de pessoa. Recusa caso já fechado. Não há reabertura por esta capacidade.",
  inputSchema: encerrarInputShape,
  category: "write",
  requiresRole: "agent",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const encerrado = await encerrarChamadoPeloAgente(
      getRequestPool(),
      ctx.organizationId,
      input.case_id,
      { desfecho: input.outcome as DesfechoDoChamado, nota: input.note },
    );
    if (!encerrado) throw new Error("case_not_open");

    const a = actorAudit(ctx);
    await audit({
      action: "ai.case_closed_by_agent",
      actorUserId: a.actorUserId,
      actorApiTokenId: ctx.apiTokenId,
      organizationId: ctx.organizationId,
      resourceType: "agent_case",
      resourceId: input.case_id,
      requestId: ctx.requestId,
      metadata: { ...a.metadataActor, outcome: input.outcome, via: "mcp" },
    });

    return {
      case_id: input.case_id,
      closed: true,
      outcome: input.outcome,
      status: input.outcome === "resolvido" ? "resolved" : "cancelled",
    };
  },
};

// ---------------------------------------------------------------------------
// crm_resume_ai_attendance
// ---------------------------------------------------------------------------

const retomarInputShape = {
  conversation_id: z.string().uuid(),
};

export const crmResumeAiAttendance: McpToolDefinition<typeof retomarInputShape> = {
  name: "crm_resume_ai_attendance",
  description:
    "Devolve o atendimento da conversa ao agente: solta o dono humano, limpa " +
    "contacts.force_human e bot_silenced_until, e grava no checkpoint do lead o que a pessoa " +
    "decidiu — o próximo turno abre já sabendo. Devolve `human_continuity` com o resumo. " +
    "Idempotente. SÓ uma pessoa pode chamar: um agente de IA recebe " +
    "`resume_requires_person`. Erros: conversation_not_found, assignment_conflict.",
  inputSchema: retomarInputShape,
  category: "write",
  /**
   * `agent`, e a regra dura mora no handler, NÃO no papel.
   *
   * A tentação era exigir `manager` para impedir o agente de desfazer a própria
   * passagem. Medido: `lib/ai/runtime/agent.ts` grava `role: "agent"` fixo (3
   * pontos), `mcp_token.ts` mint a `"role:agent"` sem parâmetro para variar, e
   * `ensureRole` compara por `ROLE_RANK` — então `manager` aqui não seria uma
   * regra, seria uma capacidade INALCANÇÁVEL por qualquer agente publicado,
   * devolvendo `Role 'agent' insufficient` ao modelo. Regra que só funciona por
   * acidente de ranking é regra que ninguém consegue ler nem testar.
   */
  requiresRole: "agent",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    // REGRA DURA 2, dita em voz alta: quem devolve o atendimento é uma PESSOA.
    // O cliente pediu para falar com gente; o agente desfazer a própria passagem
    // seria devolvê-lo à automação contra o que ele pediu.
    if (ctx.actor.type === "ai_agent") {
      throw new Error(
        "resume_requires_person: devolver o atendimento é decisão de uma pessoa. " +
          "Você não desfaz a própria passagem — use crm_get_human_case para ler o que foi decidido.",
      );
    }

    const resultado = await devolverAtendimentoAoAgente(
      {
        supabase: ctx.supabase,
        organizationId: ctx.organizationId,
        actor: ctx.actor,
        requestId: ctx.requestId,
        apiTokenId: ctx.apiTokenId,
      },
      { conversationId: input.conversation_id },
    );
    if (!resultado.ok) throw new Error(resultado.erro);

    return {
      conversation_id: resultado.conversationId,
      resumed: true,
      already_with_agent: resultado.jaEstavaComOAgente,
      human_continuity: {
        had_human_attendance: resultado.continuidade.houveAtendimentoHumano,
        summary: resultado.continuidade.resumo,
        pending_with_customer: resultado.continuidade.pendenciaComOCliente,
        decisions: resultado.continuidade.decisoes,
        notes: resultado.continuidade.notas,
      },
      next_action: resultado.continuidade.houveAtendimentoHumano
        ? "Retome citando o que a pessoa combinou com o cliente — o resumo já está no contexto do próximo turno."
        : "Atendimento devolvido; não houve registro humano nesta conversa.",
    };
  },
};
