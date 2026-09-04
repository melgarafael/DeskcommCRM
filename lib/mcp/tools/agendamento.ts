/**
 * As ferramentas de AGENDA — a IA consulta horário e (adiante) marca compromisso.
 *
 * ⚠️ FACHADA FINA. Nenhuma regra nasce aqui: o cálculo é de
 * `lib/agenda/horarios-livres.ts` e a coleta é de `lib/agenda/consulta.ts` — a
 * MESMA que `GET /api/v1/agenda/horarios-livres` usa. Duas coletas dariam à IA e
 * à tela respostas diferentes sobre o mesmo horário, e o sintoma seria a IA
 * oferecendo um horário que a tela não mostra.
 *
 * ⚠️ COMPROMISSO NÃO É RETORNO, e o catálogo tem as duas famílias com os MESMOS
 * verbos (`crm_schedule_followup` × marcar consulta). A `description` de cada
 * lado abre pelo discriminante — *a outra pessoa combinou e sabe?* e *isso ocupa
 * o tempo de alguém?* — antes de dizer o que a ferramenta faz. Contrato inteiro
 * em `cal-briefings/CONTRATO-MCP-agenda.md`.
 *
 * ⚠️ `ctx.supabase` É SERVICE ROLE e bypassa a RLS: `horariosLivresDaOrg` recebe
 * `ctx.organizationId` e filtra `organization_id` em toda query. Está escrito lá
 * dentro, e é o que separa esta chamada de um vazamento entre organizações.
 */
import { z } from "zod";

import {
  horariosLivresDaOrg,
  idDoTipoPorSlug,
  listaAgendamentos,
  listaTiposDeAtendimento,
  MAXIMO_DE_DIAS,
} from "@/lib/agenda/consulta";
import { rotuloDoLocal } from "@/lib/agenda/locais";
import { rotuloLocal } from "@/lib/tempo/agora";
import {
  alterarAgendamentoHandler,
  cancelarAgendamentoHandler,
  marcarAgendamentoHandler,
} from "@/app/api/v1/agenda/agendamentos/_handler";
import { ApiError } from "@/lib/api/types";
import { SITUACOES_DO_AGENDAMENTO } from "@/lib/agenda/tipos";
import type { McpToolDefinition } from "@/lib/mcp/types";

/** Teto do horizonte pedido — espelha o da rota, e o excesso é erro de chamada. */
const DIAS_PADRAO = 14;

/**
 * Quantos horários voltam ao modelo, e por que existe um teto.
 *
 * ⚠️ NÃO HAVIA NENHUM. Medido no formato atual, a chamada PADRÃO de 14 dias
 * devolve 177 horários — cerca de 3.600 tokens de lista, todos entrando inteiros
 * no contexto do turno; no teto de 62 dias são 788. Isso é caro e é pior que
 * caro: um modelo que recebe 177 opções escolhe mal, e a lista empurra para fora
 * do contexto o que a pessoa disse.
 *
 * A irmã `crm_list_appointments` já tinha teto (`limite`, máx. 50). Esta não —
 * a assimetria era descuido, não decisão.
 */
const HORARIOS_PADRAO = 24;
const HORARIOS_MAX = 50;

/**
 * ⚠️ CORTAR PELA CABEÇA ENVIESA. 24 horários numa grade de 30 minutos sobre um
 * expediente de 9h são um dia e meio: um pedido de "semana que vem" voltaria só
 * com amanhã, e o modelo concluiria que não há vaga na semana que vem.
 *
 * Espalhar pega os primeiros de CADA dia até o teto, o que preserva a forma da
 * janela pedida — a pessoa vê opções ao longo do período que ela citou.
 */
function espalhaPorDia(
  slots: readonly { inicio: Date; fim: Date }[],
  fuso: string,
  teto: number,
): { inicio: Date; fim: Date }[] {
  const porDia = new Map<string, { inicio: Date; fim: Date }[]>();
  for (const s of slots) {
    const dia = rotuloLocal(s.inicio, fuso).slice(0, 20);
    const lista = porDia.get(dia);
    if (lista) lista.push(s);
    else porDia.set(dia, [s]);
  }
  const escolhidos: { inicio: Date; fim: Date }[] = [];
  // Rodadas: um de cada dia por vez, na ordem em que os dias aparecem.
  for (let rodada = 0; escolhidos.length < teto; rodada += 1) {
    let achouAlgum = false;
    for (const lista of porDia.values()) {
      const s = lista[rodada];
      if (s === undefined) continue;
      achouAlgum = true;
      escolhidos.push(s);
      if (escolhidos.length >= teto) break;
    }
    if (!achouAlgum) break;
  }
  return escolhidos.sort((a, b) => a.inicio.getTime() - b.inicio.getTime());
}

/**
 * ⚠️ SEM INPUT, e o precedente é `crm_list_team_members` (`operacao.ts`). Um
 * filtro aqui só criaria como errar: o modelo passaria o nome que o paciente
 * disse ("botox") e receberia lista vazia de uma organização que atende
 * exatamente isso sob outro nome ("HOF e Botox").
 */
const tiposShape = {};

export const crmListEventTypes: McpToolDefinition<typeof tiposShape> = {
  name: "crm_list_event_types",
  description:
    "Lista o que esta organização atende — os tipos de atendimento que dá para marcar, quanto cada " +
    "um dura e como é feito. " +
    "CHAME ANTES de oferecer horário ou marcar qualquer coisa: `crm_find_free_slots` e " +
    "`crm_book_appointment` exigem `event_type_slug`, e ele tem de ser um `slug` que voltou daqui. " +
    "NUNCA invente um slug nem traduza o que a pessoa disse por conta própria: ela fala 'botox' e o " +
    "atendimento pode se chamar outra coisa — é você que faz a ponte, olhando esta lista. " +
    "Lista vazia significa que ninguém cadastrou o que a organização atende: não invente atendimento, " +
    "avise que alguém da equipe confirma. " +
    "`precisa_confirmacao: true` muda o que você diz depois de marcar — o horário fica reservado " +
    "AGUARDANDO a pessoa confirmar, não confirmado.",
  inputSchema: tiposShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (_input, ctx) => {
    const r = await listaTiposDeAtendimento(ctx.supabase, ctx.organizationId);
    if (!r.ok) {
      return { tipos: [], motivo: r.codigo, mensagem: r.motivoParaCliente };
    }
    return {
      tipos: r.tipos.map((t) => ({
        // O SLUG vem primeiro, e o `id` NÃO vem: o slug existe para dar à IA um
        // handle que ela não alucina, e devolver o uuid ao lado convidaria o
        // modelo a mandá-lo onde slug é esperado.
        slug: t.slug,
        nome: t.nome,
        descricao: t.descricao,
        duracao_minutos: t.duracaoMin,
        // Traduzido: `in_person` é vocabulário de banco e o modelo repassa o que
        // recebe. `rotuloDoLocal` é o MESMO tradutor que a tela usa.
        onde: rotuloDoLocal(t.localKind, t.localDetalhes) ?? null,
        precisa_confirmacao: t.precisaConfirmacao,
      })),
    };
  },
};

const horariosLivresShape = {
  event_type_slug: z
    .string()
    .min(1)
    .describe("o identificador legível do tipo de atendimento (ex.: 'consulta-inicial')"),
  /**
   * ⚠️ O MODELO NÃO SABE QUE DIA É HOJE — medido neste repo, num turno real: pedido
   * "daqui a três dias", ele mandou a data do treino dele. Por isso o caminho
   * PADRÃO é relativo, e a data absoluta é a exceção de quem realmente a conhece.
   * Mesma decisão de `crm_schedule_followup` (`lib/mcp/tools/retencao.ts`).
   */
  dias_a_frente: z
    .number()
    .int()
    .min(1)
    .max(MAXIMO_DE_DIAS)
    .optional()
    .describe(`quantos dias olhar a partir de agora (padrão ${DIAS_PADRAO}). Use ESTE campo se você não sabe a data de hoje.`),
  de: z.string().datetime({ offset: true }).optional(),
  ate: z.string().datetime({ offset: true }).optional(),
  owner_user_id: z.string().uuid().optional(),
  limite: z
    .number()
    .int()
    .min(1)
    .max(HORARIOS_MAX)
    .optional()
    .describe(`quantos horários no máximo (padrão ${HORARIOS_PADRAO})`),
};

export const crmFindFreeSlots: McpToolDefinition<typeof horariosLivresShape> = {
  name: "crm_find_free_slots",
  description:
    "Mostra os horários livres de um tipo de atendimento, já considerando a jornada de trabalho " +
    "do atendente, folgas, o que ele já tem marcado e a agenda externa dele. " +
    "Use ANTES de oferecer horário ao cliente: oferecer um horário que não existe e depois voltar " +
    "atrás é pior do que demorar um instante a mais para responder. " +
    "Cada horário vem em dois formatos: `inicio` é o instante que você COPIA para `starts_at` de " +
    "`crm_book_appointment`, sem reescrever; `quando` já está na hora local da agenda e é o que você " +
    "fala com a pessoa. " +
    "A lista vem cortada no `limite` e espalhada ao longo do período: `total_de_horarios` diz quantos " +
    "existem e `ha_mais` avisa que sobraram — lista cortada NÃO é agenda cheia. " +
    "QUANDO: informe `dias_a_frente` (a partir de agora — ex.: 7 para a próxima semana). " +
    "SE VOCÊ NÃO SABE QUE DIA É HOJE, USE `dias_a_frente` — não tente montar `de`/`ate`. " +
    "Lista vazia NÃO é erro e NÃO significa que a agenda está cheia: leia `publicou_horarios`. " +
    "Se ele for false, o atendente ainda não publicou os horários dele — não invente horários e " +
    "não diga que está lotado; avise que alguém da equipe confirma. " +
    "Se `fuso_suposto` for true, o fuso da agenda não foi escolhido por ninguém, veio do padrão: " +
    "ofereça o horário pedindo confirmação em vez de afirmar.",
  inputSchema: horariosLivresShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    const agora = new Date();
    const de = input.de ? new Date(input.de) : agora;
    const ate = input.ate
      ? new Date(input.ate)
      : new Date(de.getTime() + (input.dias_a_frente ?? DIAS_PADRAO) * 86_400_000);

    if (ate.getTime() <= de.getTime()) {
      return {
        horarios: [],
        motivo: "periodo_invalido",
        mensagem: "o fim do período precisa ser depois do começo. Use `dias_a_frente` se não souber a data de hoje.",
      };
    }
    if (ate.getTime() - de.getTime() > MAXIMO_DE_DIAS * 86_400_000) {
      return {
        horarios: [],
        motivo: "periodo_longo_demais",
        mensagem: `o período não pode passar de ${MAXIMO_DE_DIAS} dias. Peça um intervalo menor.`,
      };
    }

    const consulta = await horariosLivresDaOrg(ctx.supabase, ctx.organizationId, {
      eventTypeSlug: input.event_type_slug,
      ownerUserId: input.owner_user_id ?? null,
      de,
      ate,
      agora,
    });

    // Recusa de NEGÓCIO volta como RESPOSTA, nunca exceção: exceção mata o turno
    // e o assistente emudece na frente do cliente (`repo-mcp.md` §7.5).
    if (!consulta.ok) {
      return {
        horarios: [],
        motivo: consulta.codigo,
        // A face do CLIENTE, nunca a do operador: `motivoParaOperador` nomeia
        // campo e pessoa, e o modelo repassa o que recebe (DECISÃO 20).
        mensagem: consulta.motivoParaCliente,
      };
    }

    // O fuso é o DA REGRA (a jornada do atendente), nunca o da organização: é
    // nele que os horários foram calculados, e é o que esta resposta já publica.
    // Rotular com outro faria `quando` discordar de `fuso_da_regra` na mesma
    // resposta.
    const escolhidos = espalhaPorDia(
      consulta.slots,
      consulta.fusoDaRegra,
      input.limite ?? HORARIOS_PADRAO,
    );

    return {
      horarios: escolhidos.map((s) => ({
        // `inicio` é o que volta em `starts_at` — copie, não reescreva.
        inicio: s.inicio.toISOString(),
        fim: s.fim.toISOString(),
        // `quando` é para FALAR com a pessoa. Um só, e do início: o fim não
        // responde pergunta nenhuma (a duração é do tipo) e dobraria o custo.
        quando: rotuloLocal(s.inicio, consulta.fusoDaRegra),
      })),
      // Sem estes dois, uma lista cortada é indistinguível de uma agenda que
      // acabou — o mesmo modo de falha que `publicou_horarios` existe para
      // evitar.
      total_de_horarios: consulta.slots.length,
      ha_mais: consulta.slots.length > escolhidos.length,
      fuso_da_regra: consulta.fusoDaRegra,
      /** false = o atendente NÃO publicou jornada. Diferente de "sem vaga" (DECISÃO 1.1). */
      publicou_horarios: consulta.publicouHorarios,
      /** true = o fuso veio do padrão, ninguém escolheu (DECISÃO 20.2). */
      fuso_suposto: consulta.fusoSuposto,
      /** Agendas externas que não estão saudáveis: o horário pode estar defasado. */
      fontes_defasadas: consulta.fontesDefasadas,
    };
  },
};


const listarShape = {
  // As duas descrições existem porque o modelo escolhia entre os dois campos no
  // escuro — nenhum tinha `.describe()`, e a única pista era o nome do campo no
  // contexto do turno, que chama o CONTATO de `lead_id`. (issue #509)
  contact_id: z
    .string()
    .uuid()
    .optional()
    .describe(
      "o id da PESSOA (o contato da conversa). É este que você quer na quase totalidade dos " +
        "casos: o campo `lead_id` do contexto do turno carrega justamente o id do contato, " +
        "então passe aquele valor AQUI.",
    ),
  lead_id: z
    .string()
    .uuid()
    .optional()
    .describe(
      "o id do NEGÓCIO no funil (a oportunidade), não o da pessoa. Só use quando estiver " +
        "consultando os compromissos vinculados a um negócio específico.",
    ),
  dia: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("um dia específico, no formato AAAA-MM-DD"),
  owner_user_id: z.string().uuid().optional(),
  /**
   * ⚠️ A constante, NUNCA os literais. `SITUACOES_DO_AGENDAMENTO` é a fonte
   * (`lib/agenda/tipos.ts`), e o invariante `vocabulario-banco-x-typescript` existe
   * para impedir a terceira lista. Escrevi `scheduled|done|cancelled` no contrato antes
   * de ler a fonte, e estava errado nos três.
   */
  situacao: z.enum(SITUACOES_DO_AGENDAMENTO).optional(),
  limite: z.number().int().min(1).max(50).optional(),
};

export const crmListAppointments: McpToolDefinition<typeof listarShape> = {
  name: "crm_list_appointments",
  description:
    "Lista os compromissos com HORA MARCADA de um cliente, ou de um dia da equipe, com a " +
    "situação de cada um. Informe pelo menos um recorte: contact_id, lead_id, dia ou " +
    "owner_user_id — sem recorte a chamada é recusada, porque varrer a agenda inteira não " +
    "responde pergunta nenhuma. " +
    "NÃO CONFUNDA COM `crm_list_followups`, que lista os RETORNOS — as vezes em que nós " +
    "decidimos voltar a falar, sem nada combinado com o cliente. Aqui é o que foi combinado " +
    "COM ele e ocupa o tempo de um atendente. O mesmo cliente pode ter os dois. " +
    "USE ANTES DE MARCAR e antes de cobrar: cliente que já tem consulta marcada não deve " +
    "receber oferta de horário como se não tivesse, nem ser cobrado como se estivesse parado.",
  inputSchema: listarShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    const r = await listaAgendamentos(ctx.supabase, ctx.organizationId, {
      contactId: input.contact_id ?? null,
      leadId: input.lead_id ?? null,
      dia: input.dia ?? null,
      ownerUserId: input.owner_user_id ?? null,
      situacao: input.situacao ?? null,
      limite: input.limite ?? 20,
    });

    // Recusa de negócio é RESPOSTA, e a face que sai é a do CLIENTE (DECISÃO 20).
    if (!r.ok) {
      return { compromissos: [], motivo: r.codigo, mensagem: r.motivoParaCliente };
    }

    return {
      compromissos: r.agendamentos.map((a) => ({
        id: a.id,
        titulo: a.titulo,
        inicio: a.iniciaEm,
        fim: a.terminaEm,
        fuso: a.fuso,
        situacao: a.situacao,
        contato_id: a.contatoId,
        atendente_id: a.donoId,
      })),
    };
  },
};


// ─────────────────────────────────────────────────────────────────────────────
// AS ESCRITAS
//
// ⚠️ OS HANDLERS LANÇAM `ApiError`, E EXCEÇÃO MATA O TURNO. Numa rota HTTP isso é
// certo — o wrapper traduz em status. Numa ferramenta MCP não: exceção sobe pela
// ponte e o assistente EMUDECE na frente do cliente, no meio de uma conversa sobre
// marcar consulta. Por isso toda escrita aqui captura e devolve `{ motivo, mensagem }`,
// que é a regra do repo para limite de negócio (`pesquisa/repo-mcp.md` §7.5).
//
// A tradução é por CÓDIGO, e o texto é a face do CLIENTE: o `message` do ApiError é
// escrito para o operador e pode nomear campo e pessoa (DECISÃO 20).
// ─────────────────────────────────────────────────────────────────────────────

/** O que o modelo ouve em cada recusa — e cada uma diz o que FAZER, não só o que não deu. */
const ENSINO_POR_CODIGO: Record<string, string> = {
  agenda_horario_indisponivel:
    "esse horário acabou de ficar indisponível. Chame `crm_find_free_slots` de novo e ofereça um dos horários que voltarem.",
  agenda_fora_da_jornada:
    "esse horário está fora do expediente do atendente. Chame `crm_find_free_slots` e ofereça um dos que ele devolver — não insista no horário pedido.",
  agenda_tipo_desativado:
    "esse tipo de atendimento não está sendo agendado agora. Pergunte que outro atendimento serve, ou avise que alguém da equipe confirma.",
  agenda_sem_responsavel:
    "esse atendimento ainda não tem responsável definido. Não invente horários: avise que alguém da equipe confirma.",
  agenda_disponibilidade_invalida:
    "não consigo ler a agenda desse atendente agora. Não ofereça horários e não diga que está sem vaga — avise que alguém da equipe confirma.",
  agenda_ja_cancelado:
    "esse compromisso já estava desmarcado. Não é erro: siga sem desmarcar de novo.",
  agenda_ainda_nao_aconteceu:
    "esse compromisso ainda não começou, então não há desfecho a registrar. Se a pessoa avisou que " +
    "não vem, use `crm_cancel_appointment`; se ela quer outro dia, `crm_reschedule_appointment`.",
  not_found: "não encontrei esse compromisso. Confirme com `crm_list_appointments` antes de tentar de novo.",
  internal_error: "não consegui completar agora. Avise que alguém da equipe confirma, e não repita a tentativa.",
};

/** Captura o `ApiError` do handler e devolve recusa de NEGÓCIO, nunca exceção. */
async function semDerrubarOTurno<T>(
  chave: string,
  fn: () => Promise<T>,
): Promise<T | { [k: string]: unknown; motivo: string; mensagem: string }> {
  try {
    return await fn();
  } catch (e) {
    if (!(e instanceof ApiError)) throw e; // infra sobe: não é limite de negócio.
    return {
      [chave]: false,
      motivo: e.code,
      mensagem:
        ENSINO_POR_CODIGO[e.code] ??
        "não consegui completar agora. Avise que alguém da equipe confirma o horário.",
    };
  }
}

const marcarShape = {
  event_type_slug: z.string().min(1).describe("o identificador legível do tipo de atendimento"),
  starts_at: z.string().datetime({ offset: true }).describe("o instante exato do início, vindo de `crm_find_free_slots`"),
  contact_id: z.string().uuid().describe("quem vai ser atendido"),
  owner_user_id: z.string().uuid().optional(),
  title: z.string().min(1).max(200).optional(),
  notes: z.string().max(2000).optional(),
};

export const crmBookAppointment: McpToolDefinition<typeof marcarShape> = {
  name: "crm_book_appointment",
  description:
    "Marca um compromisso com HORA COMBINADA entre o cliente e um atendente — consulta, sessão, " +
    "visita, reunião. Use quando o cliente ESCOLHEU um horário e vai comparecer: isto reserva o " +
    "tempo de uma pessoa da equipe, e o cliente conta com ele. " +
    "NÃO use para 'voltar a falar com o cliente depois' — isso é retorno, e a ferramenta é " +
    "`crm_schedule_followup`. A diferença: aqui as DUAS partes combinaram e alguém vai esperar; " +
    "lá é decisão interna nossa e o cliente não sabe de nada. " +
    "Chame `crm_find_free_slots` ANTES e use um `starts_at` que veio de lá — marcar em horário que " +
    "não está livre é recusado, e a recusa manda você consultar de novo.",
  inputSchema: marcarShape,
  category: "write",
  requiresRole: "ai_operator",
  requiresScope: "mcp:write",
  handler: async (input, ctx) =>
    semDerrubarOTurno("marcado", async () => {
      const tipo = await idDoTipoPorSlug(ctx.supabase, ctx.organizationId, input.event_type_slug);
      if (!tipo) {
        return {
          marcado: false,
          motivo: "tipo_desconhecido",
          mensagem: `não existe atendimento chamado "${input.event_type_slug}". Pergunte que tipo de atendimento a pessoa quer.`,
        };
      }
      const r = await marcarAgendamentoHandler(
        ctx.supabase,
        { organization_id: ctx.organizationId, actor: ctx.actor, requestId: ctx.requestId },
        {
          event_type_id: tipo.id,
          starts_at: input.starts_at,
          contact_id: input.contact_id,
          ...(input.owner_user_id ? { owner_user_id: input.owner_user_id } : {}),
          ...(input.title ? { title: input.title } : {}),
          ...(input.notes ? { notes: input.notes } : {}),
        },
      );
      return { marcado: true, compromisso: r };
    }),
};

const remarcarShape = {
  appointment_id: z.string().uuid(),
  new_starts_at: z.string().datetime({ offset: true }).describe("o novo início, vindo de `crm_find_free_slots`"),
  notes: z.string().max(2000).optional(),
};

export const crmRescheduleAppointment: McpToolDefinition<typeof remarcarShape> = {
  name: "crm_reschedule_appointment",
  description:
    "Move um compromisso já marcado para outro horário, mantendo o mesmo cliente e o mesmo tipo. " +
    "Use quando o cliente pediu para mudar o dia ou a hora. " +
    "REMARCAR NÃO É CANCELAR E MARCAR DE NOVO: é o MESMO compromisso mudando de hora, o histórico " +
    "continua um só e o lembrete é refeito sozinho. Se você cancelar e marcar, o cliente recebe " +
    "dois avisos contraditórios e a linha do tempo dele passa a contar que ele desistiu e voltou — " +
    "o que não aconteceu. " +
    "Confirme o horário novo com `crm_find_free_slots` antes: horário indisponível é recusado.",
  inputSchema: remarcarShape,
  category: "write",
  requiresRole: "ai_operator",
  requiresScope: "mcp:write",
  handler: async (input, ctx) =>
    semDerrubarOTurno("remarcado", async () => {
      const r = await alterarAgendamentoHandler(
        ctx.supabase,
        { organization_id: ctx.organizationId, actor: ctx.actor, requestId: ctx.requestId },
        {
          id: input.appointment_id,
          starts_at: input.new_starts_at,
          ...(input.notes ? { notes: input.notes } : {}),
        },
      );
      return { remarcado: true, compromisso: r };
    }),
};

const cancelarShape = {
  appointment_id: z.string().uuid(),
  /**
   * OBRIGATÓRIO, e não é burocracia: é o que a equipe lê ao ver o horário vago.
   * Se você não tiver de onde tirar, escreva o que o cliente disse — melhor uma
   * frase sua que um campo vazio.
   */
  reason: z.string().min(3).max(500),
};

export const crmCancelAppointment: McpToolDefinition<typeof cancelarShape> = {
  name: "crm_cancel_appointment",
  description:
    "Desmarca um compromisso que ainda não aconteceu e LIBERA o horário para outra pessoa. " +
    "Use quando o cliente avisou que não vem, ou pediu para desmarcar. " +
    "NÃO use para 'não preciso mais falar com esse cliente' — isso é `crm_cancel_followup`. " +
    "NÃO use para remarcar: se o cliente quer outro dia, use `crm_reschedule_appointment`; " +
    "cancelar solta o horário e ele pode ser tomado por outro cliente em segundos, e isso não " +
    "dá para desfazer. " +
    "Informe `reason` — é o que a equipe vai ler ao ver o horário vago.",
  inputSchema: cancelarShape,
  category: "write",
  requiresRole: "ai_operator",
  requiresScope: "mcp:write",
  handler: async (input, ctx) =>
    semDerrubarOTurno("cancelado", async () => {
      const r = await cancelarAgendamentoHandler(
        ctx.supabase,
        { organization_id: ctx.organizationId, actor: ctx.actor, requestId: ctx.requestId },
        { id: input.appointment_id, reason: input.reason },
      );
      return { cancelado: true, compromisso: r };
    }),
};

const confirmarShape = {
  appointment_id: z.string().uuid().describe("o compromisso, vindo de `crm_list_appointments`"),
  notes: z.string().max(2000).optional(),
};

export const crmConfirmAppointment: McpToolDefinition<typeof confirmarShape> = {
  name: "crm_confirm_appointment",
  description:
    "Confirma que o cliente VAI COMPARECER a um compromisso que estava aguardando a resposta dele. " +
    "Use quando ele disser que vem — 'confirmado', 'pode marcar', 'estarei lá'. " +
    "Serve só para compromisso na situação `pending`: chame `crm_list_appointments` antes e veja a " +
    "situação. Confirmar o que já estava confirmado devolve `ja_estava: true` — não é erro, e não é " +
    "motivo para avisar a pessoa de novo. " +
    "NÃO use para dizer que o atendimento ACONTECEU: isso é `crm_set_appointment_outcome`, e é depois " +
    "da hora.",
  inputSchema: confirmarShape,
  category: "write",
  requiresRole: "ai_operator",
  requiresScope: "mcp:write",
  handler: async (input, ctx) =>
    semDerrubarOTurno("confirmado", async () => {
      const r = await alterarAgendamentoHandler(
        ctx.supabase,
        { organization_id: ctx.organizationId, actor: ctx.actor, requestId: ctx.requestId },
        {
          id: input.appointment_id,
          status: "confirmed",
          ...(input.notes ? { notes: input.notes } : {}),
        },
      );
      return { confirmado: true, compromisso: r };
    }),
};

const desfechoShape = {
  appointment_id: z.string().uuid().describe("o compromisso, vindo de `crm_list_appointments`"),
  outcome: z
    .enum(["completed", "no_show"])
    .describe("`completed` = a pessoa foi atendida; `no_show` = ela não apareceu e não avisou"),
  notes: z.string().max(2000).optional(),
};

export const crmSetAppointmentOutcome: McpToolDefinition<typeof desfechoShape> = {
  name: "crm_set_appointment_outcome",
  description:
    "Registra o que ACONTECEU num compromisso que JÁ PASSOU: a pessoa foi atendida (`completed`) ou " +
    "não apareceu (`no_show`). " +
    "SÓ DEPOIS DA HORA — compromisso futuro é recusado, porque você não sabe o que ainda vai " +
    "acontecer. Veja a hora do compromisso em `crm_list_appointments` e compare com a data de hoje. " +
    "NÃO use para quem AVISOU que não vem: isso é `crm_cancel_appointment`, que desmarca com o motivo " +
    "registrado e libera o horário para outra pessoa. `no_show` é para quem não avisou e não veio — " +
    "é um registro sobre o passado, e a equipe lê isso como falta.",
  inputSchema: desfechoShape,
  category: "write",
  requiresRole: "ai_operator",
  requiresScope: "mcp:write",
  handler: async (input, ctx) =>
    semDerrubarOTurno("registrado", async () => {
      const r = await alterarAgendamentoHandler(
        ctx.supabase,
        { organization_id: ctx.organizationId, actor: ctx.actor, requestId: ctx.requestId },
        {
          id: input.appointment_id,
          status: input.outcome,
          ...(input.notes ? { notes: input.notes } : {}),
        },
      );
      return { registrado: true, compromisso: r };
    }),
};
