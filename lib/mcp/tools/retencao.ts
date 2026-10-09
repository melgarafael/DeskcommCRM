/**
 * As MÃOS que impedem uma demanda de morrer (IA 360 · wave 2).
 *
 * Seis capacidades sobre o mesmo eixo: marcar o próximo passo (agendar, cancelar
 * e listar retorno), enxergar quem esfriou (radar), propor a retomada e registrar
 * o desfecho. É o pacote `reter` do catálogo — o invariante 4 da doutrina
 * (`docs/doctrine/sistema-vivo.md`) executável pelo agente que o dono configura.
 *
 * ⚠️ FACHADA FINA (Decisão 4 do briefing). Nenhuma regra de negócio nasce aqui:
 *   - o retorno é de `lib/followup/retorno.ts` + `retorno-crm.ts`, a MESMA regra
 *     que o motor do agente executa sobre `pg.Pool`;
 *   - o radar é de `lib/leads/radar-de-risco.ts`, extraído da rota que a tela usa;
 *   - o encerramento é de `lib/leads/encerramento.ts`, extraído das rotas de
 *     ganho/perda;
 *   - a proposta de reativação é de `lib/leads/reactivation.ts`, a mesma que o
 *     observador de risco cria.
 * Reimplementar qualquer uma faria a IA e o humano operarem por regras
 * diferentes, e o sistema mentiria para um dos dois.
 *
 * ⚠️ PAPEL: as leituras e o encerramento pedem `agent`; AGENDAR e CANCELAR
 * retorno pedem `ai_operator`. A distinção não é estética.
 *
 * As rotas equivalentes (`ai/followups/enrollments` POST e `.../[id]/cancel`
 * POST) exigem `manager`: um ATENDENTE humano não mexe na régua de retorno pela
 * tela. Deixar essas duas em `agent` daria à IA um poder que o produto não dá a
 * uma pessoa do mesmo papel — divergência na direção perigosa. Fechá-las em
 * `manager` tiraria do agente o que ele existe para fazer, e o invariante 4 da
 * doutrina (nenhuma demanda sem próximo passo) voltaria a ser incumprível.
 *
 * `ai_operator` resolve os dois: senta entre `agent` e `manager`, existe SÓ no
 * escopo do token efêmero e NUNCA em `user_organizations`. O agente alcança; um
 * atendente humano não; um gerente continua alcançando pela rota. A tenancy
 * segue vindo de `ctx.organizationId`, nunca do input.
 *
 * ⚠️ RECUSA DE NEGÓCIO NÃO É EXCEÇÃO. "Já existe um retorno vivo" e "esta
 * oportunidade não existe" são RESPOSTAS: o modelo precisa aprender e seguir, não
 * receber um erro que o faz tentar de novo igual. Só falha de infraestrutura sobe
 * como exceção (o wrapper do runtime a devolve como `{ error }` e o audit marca
 * a chamada como malsucedida).
 */
import { z } from "zod";

import { audit } from "@/lib/audit";
import {
  agendaRetornoNoCrm,
  cancelaRetornoNoCrm,
  listaRetornosNoCrm,
} from "@/lib/followup/retorno-crm";
import { duracaoLegivel } from "@/lib/followup/retorno";
import { ApiError } from "@/lib/api/types";
import { encerraDemanda } from "@/lib/leads/encerramento";
import { carregaRadarDeRisco } from "@/lib/leads/radar-de-risco";
import { contatoDoNegocio } from "@/lib/operacao/modelos-de-mensagem";
import { propoeReativacao } from "@/lib/leads/reactivation";
import { resolveStageWindow } from "@/lib/leads/risk-radar";
import type { McpContext, McpToolDefinition } from "../types";

/** Payload de auditoria a partir do ator do ctx (user humano ou agente). */
function actorAudit(ctx: McpContext): {
  actorUserId: string | null;
  metadataActor: Record<string, unknown>;
} {
  if (ctx.actor.type === "user") {
    return { actorUserId: ctx.actor.id, metadataActor: { actor_type: "user" } };
  }
  return {
    actorUserId: null,
    metadataActor: { actor_type: ctx.actor.type, actor_id: ctx.actor.id },
  };
}

/** Texto de ENSINO para os alvos que não existem — o modelo corrige e segue. */
const ENSINO_DE_ALVO: Record<string, string> = {
  negocio_nao_encontrado:
    "não existe oportunidade com esse identificador nesta organização — confira com a capacidade de listar oportunidades antes de tentar de novo.",
  negocio_sem_contato:
    "esta oportunidade não tem cliente vinculado, então não há para quem voltar a falar. Vincule um cliente antes de marcar um retorno.",
  cliente_nao_encontrado:
    "informe o identificador da oportunidade (lead_id) ou do cliente (contact_id) — um dos dois é obrigatório e precisa existir nesta organização.",
};

// ---------------------------------------------------------------------------
// crm_schedule_followup
// ---------------------------------------------------------------------------

const agendarShape = {
  /** Preferido: o alvo é exato e a timeline nunca cai no negócio errado. */
  lead_id: z.string().uuid().optional(),
  contact_id: z.string().uuid().optional(),
  /** Instante ABSOLUTO (ISO 8601). Use quando você souber a data exata. */
  promised_at: z.string().min(1).max(64).optional(),
  /**
   * ⚠️ O CAMINHO QUE NÃO DEPENDE DE O AGENTE SABER QUE DIA É HOJE.
   *
   * Medido em turnos com modelo real: pedido "retornar daqui a três dias", um
   * modelo mandou `2023-10-13` (a data do próprio treino) e outro se RECUSOU a
   * inventar — "qual data e horário exatos devo usar?" — e o retorno não foi
   * marcado em nenhum dos dois. O runtime nunca diz ao agente que instante é
   * agora, e a capacidade exigia justamente isso.
   *
   * Com o prazo relativo, a conversão para absoluto acontece AQUI, no instante da
   * chamada, com o relógio do servidor. A doutrina da data absoluta continua
   * valendo onde ela importa: o que fica GRAVADO é o instante, não "amanhã" —
   * a promessa é lida dias depois e "amanhã" não significaria nada.
   */
  in_hours: z.number().positive().max(4_320).optional(),
  reason: z.string().min(1).max(500),
  promise: z.string().min(1).max(1_000),
  context: z.string().max(4_000).optional(),
};

export const crmScheduleFollowup: McpToolDefinition<typeof agendarShape> = {
  name: "crm_schedule_followup",
  description:
    "Agenda o retorno ao cliente num momento futuro. Informe lead_id OU contact_id. " +
    "QUANDO: informe `in_hours` (prazo a partir de agora — ex.: 72 para 'daqui a três dias') " +
    "OU `promised_at` (instante ISO 8601 absoluto). SE VOCÊ NÃO SABE QUE DIA É HOJE, USE " +
    "`in_hours` — é o caminho certo e não exige adivinhar a data. " +
    "Um retorno vivo por cliente: se já houver, a chamada devolve agendado=false com o motivo, " +
    "e não é erro — é para você seguir sem duplicar. " +
    "ISTO NÃO É COMPROMISSO COM HORA MARCADA: é decisão interna nossa de voltar a falar. O cliente " +
    "não fica sabendo, e nada é reservado na agenda de ninguém. Se ele ESCOLHEU um horário para ser " +
    "atendido, é outra coisa — use a ferramenta de marcar compromisso, se você tiver uma; se não " +
    "tiver, diga que alguém da equipe confirma o horário e NÃO registre isso como retorno.",
  inputSchema: agendarShape,
  category: "write",
  requiresRole: "ai_operator",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    // ⚠️ UM RELÓGIO SÓ para decidir E para ensinar. O modelo NÃO SABE QUE DIA É
    // HOJE — medido num turno real: pedido "daqui a três dias", ele mandou
    // `2023-10-13`, a data do treino dele. A recusa antiga dizia só "já passou",
    // que é verdade e é inútil: sem saber o agora, ele repetiu a MESMA data e
    // queimou os passos do turno. Quem recusa tem de devolver o que falta para
    // corrigir.
    const agora = new Date();

    // ⚠️ `in_hours` GANHA quando os dois vêm — e a primeira versão fazia o
    // contrário, "instante explícito é mais específico que prazo".
    //
    // A medição desmentiu: no turno real o modelo mandou os DOIS, com
    // `in_hours: 72` (a expressão fiel do que foi combinado) e um `promised_at`
    // fabricado a partir da data de criação do contato — porque ele não sabe que
    // dia é hoje. Preferir o campo explícito era preferir o palpite ao dado.
    //
    // Quem realmente conhece o instante manda só `promised_at`, e aí ele vale.
    const prometidoPara =
      input.in_hours !== undefined
        ? new Date(agora.getTime() + input.in_hours * 3_600_000).toISOString()
        : (input.promised_at ?? null);
    if (prometidoPara === null) {
      return {
        agendado: false,
        motivo: "quando_ausente",
        mensagem:
          "diga QUANDO: `in_hours` (prazo a partir de agora, ex.: 72 para daqui a três dias) " +
          "ou `promised_at` (instante ISO 8601 absoluto). Se você não sabe que dia é hoje, use `in_hours`.",
      };
    }

    const resultado = await agendaRetornoNoCrm(
      {
        admin: ctx.supabase,
        orgId: ctx.organizationId,
        actor: ctx.actor,
        requestId: ctx.requestId,
        agora,
      },
      { leadId: input.lead_id ?? null, contactId: input.contact_id ?? null },
      {
        motivo: input.reason,
        prometidoPara,
        promessa: input.promise,
        contexto: input.context ?? null,
      },
    );

    if (!resultado.ok) {
      if ("janela" in resultado) {
        const { minAheadMs, maxAheadMs } = resultado.janela;
        const agoraIso = agora.toISOString();
        const cedoDemais = new Date(agora.getTime() + minAheadMs).toISOString();
        const tardeDemais = new Date(agora.getTime() + maxAheadMs).toISOString();
        const ensino: Record<string, string> = {
          instante_invalido:
            `promised_at não é uma data ISO 8601 válida. AGORA é ${agoraIso} — some o prazo pedido ` +
            `a este instante e mande o resultado absoluto (ex.: '${cedoDemais}').`,
          instante_no_passado:
            `a data informada já passou: AGORA é ${agoraIso}. Some o prazo combinado a este ` +
            `instante e mande a data absoluta resultante — não repita a mesma data.`,
          instante_fora_da_janela:
            `horário fora da janela aceitável. AGORA é ${agoraIso}; o retorno tem de cair entre ` +
            `${cedoDemais} e ${tardeDemais} (${duracaoLegivel(minAheadMs)} a ${duracaoLegivel(maxAheadMs)} a partir de agora).`,
          ja_existe_retorno:
            "este cliente JÁ tem um retorno marcado — não marque outro (evita insistir com a mesma pessoa " +
            "várias vezes). Se precisa mudar o horário, cancele o existente antes.",
        };
        return {
          agendado: false,
          motivo: resultado.codigo,
          mensagem: ensino[resultado.codigo] ?? "não foi possível marcar o retorno.",
          ...(resultado.existente
            ? {
                retorno_existente: {
                  id: resultado.existente.id,
                  quando: resultado.existente.quando,
                  motivo: resultado.existente.motivo,
                },
              }
            : {}),
        };
      }
      return {
        agendado: false,
        motivo: resultado.codigo,
        mensagem: ENSINO_DE_ALVO[resultado.codigo] ?? "alvo não encontrado.",
      };
    }

    const a = actorAudit(ctx);
    await audit({
      action: "followup.scheduled",
      actorUserId: a.actorUserId,
      actorApiTokenId: ctx.apiTokenId,
      organizationId: ctx.organizationId,
      resourceType: "cron_job",
      resourceId: resultado.retorno.id,
      requestId: ctx.requestId,
      metadata: {
        ...a.metadataActor,
        via: "mcp",
        contact_id: resultado.retorno.contactId,
        lead_id: resultado.alvo?.leadId ?? null,
        quando: resultado.retorno.quando,
      },
    });

    return {
      agendado: true,
      retorno_id: resultado.retorno.id,
      quando: resultado.retorno.quando,
      lead_id: resultado.alvo?.leadId ?? null,
      contact_id: resultado.retorno.contactId,
      mensagem:
        "retorno marcado. Encerre o turno agora; o sistema volta a falar com o cliente no horário combinado.",
    };
  },
};

// ---------------------------------------------------------------------------
// crm_cancel_followup
// ---------------------------------------------------------------------------

const cancelarShape = {
  followup_id: z.string().uuid(),
  reason: z.string().min(1).max(200),
};

export const crmCancelFollowup: McpToolDefinition<typeof cancelarShape> = {
  name: "crm_cancel_followup",
  description:
    "Cancela um retorno agendado que ainda não disparou. Use quando o cliente já respondeu ou o " +
    "motivo do retorno deixou de existir — insistir com quem já respondeu é dano. " +
    "Retorno já disparado ou já cancelado devolve cancelado=false, e isso não é erro. " +
    "Cancela o RETORNO INTERNO, não um compromisso com hora marcada: se o cliente avisou que não " +
    "vai a um horário combinado com ele, esta ferramenta não desmarca isso.",
  inputSchema: cancelarShape,
  category: "write",
  requiresRole: "ai_operator",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const resultado = await cancelaRetornoNoCrm(
      {
        admin: ctx.supabase,
        orgId: ctx.organizationId,
        actor: ctx.actor,
        requestId: ctx.requestId,
      },
      input.followup_id,
      { motivo: input.reason },
    );

    if (!resultado.ok) {
      return {
        cancelado: false,
        motivo: resultado.codigo,
        mensagem:
          resultado.codigo === "nao_encontrado"
            ? "não existe retorno com esse identificador nesta organização."
            : "este retorno já aconteceu ou já tinha sido cancelado — não há o que desmarcar.",
        ...(resultado.existente ? { situacao: resultado.existente.situacao } : {}),
      };
    }

    const a = actorAudit(ctx);
    await audit({
      action: "followup.cancelled",
      actorUserId: a.actorUserId,
      actorApiTokenId: ctx.apiTokenId,
      organizationId: ctx.organizationId,
      resourceType: "cron_job",
      resourceId: resultado.retorno.id,
      requestId: ctx.requestId,
      metadata: {
        ...a.metadataActor,
        via: "mcp",
        contact_id: resultado.retorno.contactId,
        lead_id: resultado.alvo?.leadId ?? null,
      },
    });

    return {
      cancelado: true,
      retorno_id: resultado.retorno.id,
      contact_id: resultado.retorno.contactId,
      lead_id: resultado.alvo?.leadId ?? null,
    };
  },
};

// ---------------------------------------------------------------------------
// crm_list_followups
// ---------------------------------------------------------------------------

const listarShape = {
  lead_id: z.string().uuid().optional(),
  contact_id: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(100).default(20),
};

export const crmListFollowups: McpToolDefinition<typeof listarShape> = {
  name: "crm_list_followups",
  description:
    "Lista os retornos de um cliente (informe lead_id OU contact_id), do mais próximo para o mais " +
    "antigo. Cada item traz situacao: 'agendado' (ainda vai acontecer), 'disparado' (já aconteceu), " +
    "'nao_disparado' (a empresa estava parada e o retorno NÃO saiu: não diga ao cliente que saiu) ou 'cancelado' (alguém desmarcou, com motivo_do_cancelamento). Valores novos de situacao podem " +
    "aparecer em versões futuras: trate um valor desconhecido como 'não sei se saiu', nunca como 'saiu'. É por aqui que você descobre " +
    "que um humano desmarcou o retorno — se descobrir, NÃO reagende o mesmo retorno. " +
    "Lista RETORNOS INTERNOS, não compromissos com hora marcada. O mesmo cliente pode ter os dois, " +
    "e não encontrar nada aqui não significa que ele não tenha um horário combinado." +
    " Em conversa de atendimento, lista apenas os retornos do contato desta conversa (sem lead_id " +
    "nem contact_id, usa ele).",
  inputSchema: listarShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    // ── OS RETORNOS, DURANTE UM TURNO, SÃO OS DO CONTATO DESTA CONVERSA ─────
    //
    // Mesma regra de `crm_list_appointments`: sem alvo, o contato do turno;
    // `contact_id` de outro e `lead_id` cujo dono não é o do turno caem na
    // MESMA recusa — inclusive o alvo que não existe, que fora do turno tem
    // ensino próprio e aqui viraria oráculo de existência. Sem contato do
    // turno, nada muda.
    const doTurno = ctx.contatoDoTurno;
    const leadId = doTurno && input.lead_id === doTurno ? undefined : input.lead_id;
    if (doTurno) {
      const foraDoTurno =
        (input.contact_id !== undefined && input.contact_id !== doTurno) ||
        (leadId !== undefined &&
          (await contatoDoNegocio(
            { supabase: ctx.supabase, organizationId: ctx.organizationId, actor: ctx.actor, requestId: ctx.requestId },
            leadId,
          )) !== doTurno);
      if (foraDoTurno) {
        return {
          permitido: false,
          motivo: "fora_da_conversa",
          mensagem:
            "esta conversa é com outra pessoa — os retornos de quem não é este cliente não são seus " +
            "para ver; siga a conversa com quem está falando.",
        };
      }
    }
    const resultado = await listaRetornosNoCrm(
      { admin: ctx.supabase, orgId: ctx.organizationId, actor: ctx.actor, requestId: ctx.requestId },
      { leadId: leadId ?? null, contactId: doTurno ?? input.contact_id ?? null },
      { limite: input.limit },
    );

    if (!resultado.ok) {
      return {
        retornos: [],
        motivo: resultado.codigo,
        mensagem: ENSINO_DE_ALVO[resultado.codigo] ?? "alvo não encontrado.",
      };
    }

    return {
      lead_id: resultado.alvo.leadId,
      contact_id: resultado.alvo.contactId,
      retornos: resultado.retornos.map((r) => ({
        id: r.id,
        quando: r.quando,
        prometido_para: r.prometidoPara,
        situacao: r.situacao,
        motivo: r.motivo,
        promessa: r.promessa,
        cancelado_em: r.canceladoEm,
        motivo_do_cancelamento: r.motivoDoCancelamento,
      })),
    };
  },
};

// ---------------------------------------------------------------------------
// crm_list_at_risk_leads
// ---------------------------------------------------------------------------

const radarShape = {
  limit: z.number().int().min(1).max(200).default(50),
  /** Piso de horas sem movimento. Abaixo disso a demanda ainda está fresca. */
  min_hours: z.number().int().min(0).max(2000).optional(),
};

// A descrição declara `sem_proximo_passo` porque o dado chegar não basta: o
// modelo só usa o que a descrição promete. `carregaRadarDeRisco` já devolvia a
// lista desde o passo 4 do cap. 5, e sem esta linha ela viajava invisível — o
// equivalente, para o agente, de um campo que a tela recebe e não pinta.
export const crmListAtRiskLeads: McpToolDefinition<typeof radarShape> = {
  name: "crm_list_at_risk_leads",
  description:
    "Radar de risco: as oportunidades ABERTAS que passaram da janela de esfriamento do próprio " +
    "estágio. Cada item traz risk='critico'|'em_risco'|'em_voo' (em_voo = já há retorno agendado, " +
    "o sistema mantém viva), horas sem movimento, dono e a conversa. Ordenado por urgência. " +
    "Traz TAMBÉM `sem_proximo_passo`: demandas abertas para as quais nada está marcado para " +
    "acontecer — cada uma é alguém esperando sem previsão. Campos: contact_id, contact_name, " +
    "horas_aberta e origem. Essas NÃO saem sozinhas: resolva cada uma agendando um retorno " +
    "(crm_schedule_followup com contact_id) ou registrando o desfecho (crm_close_demand), " +
    "conforme o caso. `total_sem_proximo_passo` cabe zerar; é o único número aqui cujo alvo é 0." +
    " Em conversa de atendimento, o radar cobre apenas o contato desta conversa.",
  inputSchema: radarShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    const radar = await carregaRadarDeRisco(ctx.supabase, {
      organizationId: ctx.organizationId,
      // Escopo do turno nas CONSULTAS do radar, antes do corte: filtrar a
      // página depois esconderia negócios do próprio cliente.
      ...(ctx.contatoDoTurno ? { contactId: ctx.contatoDoTurno } : {}),
      limit: input.limit,
      ...(input.min_hours !== undefined ? { minHours: input.min_hours } : {}),
    });
    return radar;
  },
};

// ---------------------------------------------------------------------------
// crm_close_demand
// ---------------------------------------------------------------------------

const encerrarShape = {
  lead_id: z.string().uuid(),
  outcome: z.enum(["won", "lost"]),
  /** Obrigatório em `lost`: perder sem motivo não ensina nada a ninguém. */
  reason: z.string().min(1).max(500).optional(),
};

export const crmCloseDemand: McpToolDefinition<typeof encerrarShape> = {
  name: "crm_close_demand",
  description:
    "Encerra a demanda: move a oportunidade para o estágio terminal do funil como ganha " +
    "(outcome='won') ou perdida (outcome='lost', com reason obrigatório). É o outro lado do " +
    "acompanhamento: demanda aberta precisa de próximo passo OU de desfecho registrado. " +
    "Idempotente — encerrar de novo devolve o estado atual sem alterar nada.",
  inputSchema: encerrarShape,
  category: "write",
  requiresRole: "agent",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    try {
      const { lead, jaEstava } = await encerraDemanda(
        ctx.supabase,
        {
          organization_id: ctx.organizationId,
          actor: ctx.actor,
          requestId: ctx.requestId,
        },
        { leadId: input.lead_id, desfecho: input.outcome, motivo: input.reason ?? null },
      );
      return {
        encerrado: true,
        ja_estava: jaEstava,
        lead_id: input.lead_id,
        desfecho: input.outcome,
        status: (lead as { status?: string }).status ?? null,
      };
    } catch (err) {
      // ApiError aqui é sempre recusa de NEGÓCIO (não existe, funil sem estágio
      // terminal, perda sem motivo). Vira ensino; o modelo corrige e segue.
      if (err instanceof ApiError) {
        return { encerrado: false, motivo: err.code, mensagem: err.message };
      }
      throw err;
    }
  },
};

// ---------------------------------------------------------------------------
// crm_propose_reactivation
// ---------------------------------------------------------------------------

const reativacaoShape = {
  lead_id: z.string().uuid(),
};

export const crmProposeReactivation: McpToolDefinition<typeof reativacaoShape> = {
  name: "crm_propose_reactivation",
  description:
    "Cria uma proposta de retomada de contato para uma oportunidade que esfriou. A proposta aparece " +
    "no cartão do negócio para um humano aprovar; NADA é enviado ao cliente por conta dela, e ela " +
    "vence sozinha se ninguém decidir. Recusa se já houver proposta viva ou se o negócio não tiver " +
    "cliente vinculado.",
  inputSchema: reativacaoShape,
  category: "write",
  requiresRole: "agent",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const { data: lead, error } = await ctx.supabase
      .from("crm_leads")
      .select("id, contact_id, stage_id, status")
      .eq("organization_id", ctx.organizationId)
      .eq("id", input.lead_id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!lead) {
      return {
        proposta_criada: false,
        motivo: "negocio_nao_encontrado",
        mensagem: ENSINO_DE_ALVO.negocio_nao_encontrado,
      };
    }
    const alvo = lead as { contact_id: string | null; stage_id: string; status: string };
    if (alvo.status !== "open") {
      return {
        proposta_criada: false,
        motivo: "negocio_encerrado",
        mensagem: "este negócio já foi encerrado — não há contato a retomar.",
      };
    }
    if (!alvo.contact_id) {
      return {
        proposta_criada: false,
        motivo: "negocio_sem_contato",
        mensagem: ENSINO_DE_ALVO.negocio_sem_contato,
      };
    }

    // A janela da proposta é a MESMA que definiu o esfriamento (cabeçalho da
    // 0082): uma proposta que vence antes ou depois do prazo do estágio faria o
    // negócio sumir do quadro num ritmo que ninguém configurou.
    const { data: stage } = await ctx.supabase
      .from("crm_stages")
      .select("expected_duration_hours")
      .eq("organization_id", ctx.organizationId)
      .eq("id", alvo.stage_id)
      .maybeSingle();
    const { coldHours } = resolveStageWindow(
      stage as { expected_duration_hours: number | null } | null,
    );

    const proposta = await propoeReativacao(ctx.supabase, {
      organizationId: ctx.organizationId,
      leadId: input.lead_id,
      coldHours,
    });
    if (!proposta) {
      // `propoeReativacao` devolve null quando já existe proposta viva (ou o
      // negócio perdeu o contato entre a checagem e a criação). Não se inventa
      // aqui um motivo mais preciso do que a função pode garantir.
      return {
        proposta_criada: false,
        motivo: "ja_existe_proposta",
        mensagem:
          "este negócio já tem uma sugestão de retomada aguardando decisão de uma pessoa — não crie outra.",
      };
    }

    const a = actorAudit(ctx);
    await audit({
      action: "lead.reactivation_proposed",
      actorUserId: a.actorUserId,
      actorApiTokenId: ctx.apiTokenId,
      organizationId: ctx.organizationId,
      resourceType: "crm_lead",
      resourceId: input.lead_id,
      requestId: ctx.requestId,
      metadata: { ...a.metadataActor, via: "mcp", proposta_id: proposta.id },
    });

    return {
      proposta_criada: true,
      proposta_id: proposta.id,
      lead_id: input.lead_id,
      vence_em: proposta.expiresAt.toISOString(),
      mensagem:
        "sugestão registrada. Uma pessoa precisa aprovar antes de qualquer mensagem sair para o cliente.",
    };
  },
};

// ---------------------------------------------------------------------------
// crm_enroll_followup_flow
// ---------------------------------------------------------------------------

const inscreverShape = {
  contact_id: z.string().uuid(),
  /** O fluxo em que inscrever. `crm_list_followups` não lista fluxos; o operador escolhe na tela e o prompt traz o id. */
  flow_id: z.string().uuid(),
};

/**
 * Inscreve o contato num fluxo de acompanhamento já publicado.
 *
 * ⚠️ POR QUE ELA EXISTE, e por que não é `crm_schedule_followup` com outro nome:
 * aquela agenda UM toque e guarda a promessa em texto — quem decide o que dizer,
 * quantas vezes insistir e quando desistir continua sendo o PROMPT. Esta entrega
 * a cadência inteira ao fluxo, que é editável na tela, visível na fila e medido
 * por desfecho. O agente contribui com o que só ele sabe (que o atendimento
 * terminou sem o próximo horário marcado); o resto é configuração.
 *
 * ⚠️ RECUSA DE NEGÓCIO NÃO É EXCEÇÃO — mesma doutrina do cabeçalho deste arquivo.
 * "Já existe um acompanhamento vivo para este contato" é a resposta mais comum
 * (o índice único permite um por contato na organização inteira) e o modelo
 * precisa aprender e seguir, não receber um erro que o faça tentar de novo igual.
 */
export const crmEnrollFollowupFlow: McpToolDefinition<typeof inscreverShape> = {
  name: "crm_enroll_followup_flow",
  description:
    "Inscreve o cliente num acompanhamento já configurado (um fluxo), que cuida do resto: " +
    "quando falar, o que dizer e quando parar. Use quando o atendimento terminou e ainda há " +
    "um motivo para voltar a falar mais adiante — por exemplo, um retorno de manutenção. " +
    "ISTO NÃO FALA COM O CLIENTE AGORA e não reserva nada na agenda dele: é o acompanhamento " +
    "começando a correr. Um acompanhamento vivo por cliente: se já houver, a resposta vem com " +
    "inscrito=false e o motivo, e NÃO é erro — siga sem tentar de novo.",
  inputSchema: inscreverShape,
  category: "write",
  requiresRole: "ai_operator",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const { enrollFollowupFlow } = await import("@/lib/followup/enroll");

    const a = actorAudit(ctx);
    const r = await enrollFollowupFlow(createAdminClient(), {
      organizationId: ctx.organizationId,
      pointerId: input.flow_id,
      contactId: input.contact_id,
      actorUserId: a.actorUserId,
      requestId: ctx.requestId,
    });

    if (!r.ok) {
      // Recusa de negócio vira RESPOSTA. Só falha de infraestrutura sobe como
      // exceção — o wrapper do runtime a devolve como `{ error }` e o audit
      // marca a chamada como malsucedida.
      if (r.status >= 500) throw new ApiError(r.status, r.code, undefined, ctx.requestId, r.message);
      return {
        inscrito: false,
        motivo: r.code,
        mensagem: r.message,
      };
    }

    const enrollmentId = String((r.enrollment as { id?: unknown }).id ?? "");
    await audit({
      action: "followup_enrollment.created",
      actorUserId: a.actorUserId,
      actorApiTokenId: ctx.apiTokenId,
      organizationId: ctx.organizationId,
      resourceType: "followup_enrollment",
      resourceId: enrollmentId,
      requestId: ctx.requestId,
      metadata: { ...a.metadataActor, via: "mcp", flow_id: input.flow_id, contact_id: input.contact_id },
    });

    return {
      inscrito: true,
      enrollment_id: enrollmentId,
      mensagem:
        "acompanhamento iniciado. Não anuncie isso ao cliente: quem fala com ele é o próprio acompanhamento, no tempo dele.",
    };
  },
};
