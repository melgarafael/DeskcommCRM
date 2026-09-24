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
import { diaLocalISO } from "@/lib/agenda/fuso";
import { rotuloLocal } from "@/lib/tempo/agora";
import {
  alterarAgendamentoHandler,
  cancelarAgendamentoHandler,
  marcarAgendamentoHandler,
} from "@/app/api/v1/agenda/agendamentos/_handler";
import { ApiError } from "@/lib/api/types";
import { SITUACOES_DO_AGENDAMENTO } from "@/lib/agenda/tipos";
import type { McpContext, McpToolDefinition } from "@/lib/mcp/types";

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
    .describe(
      `quantos dias olhar a partir de agora (padrão ${DIAS_PADRAO}). Use ESTE campo se você não sabe a data de hoje. ` +
        `Se 'dia' também for informado, 'dia' tem precedência.`,
    ),
  /**
   * A data civil é deliberadamente diferente de um ISO com offset. O modelo sabe
   * que o cliente pediu "dia 13", mas não sabe onde começa esse dia no fuso da
   * agenda. Receber `de`/`ate` em UTC fez 13/09 terminar às 19:59 em Manaus e
   * descartou um horário das 21h que a própria ferramenta tinha oferecido.
   */
  dia: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "dia deve estar em YYYY-MM-DD")
    .optional()
    .describe(
      "dia civil pedido pelo cliente, em YYYY-MM-DD. Use para uma data específica; o servidor aplica o fuso da agenda " +
        "(tem precedência sobre dias_a_frente).",
    ),
  owner_user_id: z.string().uuid().optional(),
  limite: z
    .number()
    .int()
    .min(1)
    .max(HORARIOS_MAX)
    .optional()
    .describe(`quantos horários no máximo (padrão ${HORARIOS_PADRAO})`),
};

/** O ramo BOM da coleta — o que as DUAS ferramentas de agenda publicam. */
type ConsultaOk = Extract<Awaited<ReturnType<typeof horariosLivresDaOrg>>, { ok: true }>;

/**
 * A faixa UTC LARGA que CONTÉM um dia civil em qualquer fuso.
 *
 * Existe como função porque as DUAS ferramentas que OLHAM a agenda precisam
 * perguntar a mesma coisa: o dia que o cliente nomeou, sem converter "13/09" em
 * meia-noite UTC e perder a noite de Manaus (é isto que `-14h/+38h` cobre).
 */
function faixaAmplaDoDia(dia: string): { de: Date; ate: Date } {
  const inicioDoDiaUtc = new Date(`${dia}T00:00:00.000Z`);
  return {
    de: new Date(inicioDoDiaUtc.getTime() - 14 * 60 * 60 * 1000),
    ate: new Date(inicioDoDiaUtc.getTime() + 38 * 60 * 60 * 1000),
  };
}

/** "Seg 01/09 às 14:00" → "14:00": a hora local, na MESMA régua que o modelo fala. */
function horaLocalDoRotulo(rotulo: string): string {
  const marca = rotulo.lastIndexOf(" às ");
  return marca === -1 ? "" : rotulo.slice(marca + 4);
}

/** "9:00" e "09:00" são a mesma hora — o modelo escreve das duas formas. */
function normalizarHorario(horario: string): string {
  const [h = "", m = ""] = horario.split(":");
  return `${h.padStart(2, "0")}:${m.padStart(2, "0")}`;
}

/**
 * O que uma resposta de CONSULTA publica — usado por `crm_find_free_slots` E pela
 * ferramenta que consulta e marca numa chamada só (issue #831).
 *
 * Está aqui, e não copiado em cada handler, pela MESMA razão de a coleta ser uma
 * só: duas cópias divergem, e a divergência apareceria como a IA oferecendo um
 * horário que `quando`/`fuso_da_regra` desmentem.
 */
function payloadDeHorarios(
  consulta: ConsultaOk,
  slotsDoPeriodo: ConsultaOk["slots"],
  limite: number,
) {
  // O fuso é o DA REGRA (a jornada do atendente), nunca o da organização: é nele
  // que os horários foram calculados, e é o que esta resposta já publica.
  // Rotular com outro faria `quando` discordar de `fuso_da_regra` na mesma
  // resposta.
  const escolhidos = espalhaPorDia(slotsDoPeriodo, consulta.fusoDaRegra, limite);
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
    total_de_horarios: slotsDoPeriodo.length,
    ha_mais: slotsDoPeriodo.length > escolhidos.length,
    fuso_da_regra: consulta.fusoDaRegra,
    /** false = o atendente NÃO publicou jornada. Diferente de "sem vaga" (DECISÃO 1.1). */
    publicou_horarios: consulta.publicouHorarios,
    /** true = o fuso veio do padrão, ninguém escolheu (DECISÃO 20.2). */
    fuso_suposto: consulta.fusoSuposto,
    /** Agendas externas que não estão saudáveis: o horário pode estar defasado. */
    fontes_defasadas: consulta.fontesDefasadas,
    /**
     * NENHUMA conexão viva jamais sincronizou — a lista de ocupados pode estar
     * vazia porque ninguém perguntou, não porque a agenda está livre.
     *
     * O campo existia em `ResultadoDaConsulta` desde sempre e chegava SÓ à rota
     * REST (`app/api/v1/agenda/horarios-livres`): as duas tools MCP publicavam
     * `fontes_defasadas` e engoliam este, que é o mais grave dos dois. O próprio
     * comentário que o declara (lib/agenda/consulta.ts) diz que quem mais precisa
     * dele é a IA — "um agente que o oferece MARCA por cima da cirurgia e confirma
     * ao cliente" —, e com a ferramenta conjunta da #831 isso deixou de ser uma
     * segunda decisão do modelo: virou escrita na mesma chamada.
     */
    agenda_externa_nunca_lida: consulta.agendaExternaNuncaLida,
  };
}

/** A ressalva de agenda nunca sincronizada, ACRESCENTADA à mensagem da marcação. */
function comRessalvaDeAgendaNuncaLida(resultado: unknown): string {
  const original = String((resultado as { mensagem?: unknown } | null)?.mensagem ?? "").trim();
  const ressalva =
    "A agenda externa deste atendente nunca foi sincronizada, então pode haver compromisso " +
    "que não aparece aqui. Diga que separou o horário e que a equipe confirma — não afirme " +
    "que está confirmado.";
  return original.length > 0 ? `${original} ${ressalva}` : ressalva;
}

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
    "Para uma data que o cliente nomeou, use `dia` em YYYY-MM-DD; o servidor aplica o fuso da agenda. " +
    "NUNCA monte um intervalo UTC por conta própria. " +
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
    // Se o modelo enviar `dia` e `dias_a_frente` juntos, toleramos e priorizamos
    // o mais específico (`dia`), evitando recusa silenciosa em produção (#1436).

    // A faixa larga contém o dia civil em QUALQUER fuso. Depois de a coleta
    // revelar o fuso da regra, filtramos pelo mesmo dia local. Assim a IA não
    // converte "13/09" em meia-noite UTC e não perde a noite de Manaus.
    //
    // A aritmética é a de `faixaAmplaDoDia`, e é ELA que roda aqui: o helper
    // nasceu declarando que existe porque "as DUAS ferramentas que OLHAM a
    // agenda precisam perguntar a mesma coisa" e ficou com um chamador só,
    // enquanto esta cópia seguia inline — duas fontes para a mesma janela, que
    // divergem no primeiro ajuste.
    const janela = input.dia === undefined ? null : faixaAmplaDoDia(input.dia);
    const de = janela === null ? agora : janela.de;
    const ate =
      janela === null
        ? new Date(de.getTime() + (input.dias_a_frente ?? DIAS_PADRAO) * 86_400_000)
        : janela.ate;

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
    const slotsDoPeriodo =
      input.dia === undefined
        ? consulta.slots
        : consulta.slots.filter((s) => diaLocalISO(s.inicio, consulta.fusoDaRegra) === input.dia);
    return payloadDeHorarios(consulta, slotsDoPeriodo, input.limite ?? HORARIOS_PADRAO);
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
        meet_state: a.meetingState,
        meeting_url: a.meetingState === "ready" ? a.meetingUrl : null,
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
  notes: z
    .string()
    .max(2000)
    .optional()
    .describe("anotação INTERNA da equipe. Não aparece no calendário do cliente."),
  description: z
    .string()
    .max(2000)
    .optional()
    .describe("observação visível no calendário (descrição do compromisso)"),
  location_details: z
    .string()
    .max(300)
    .optional()
    .describe("endereço ou local DESTE compromisso. Vazio apaga o que o tipo sugeriu."),
};

export const crmBookAppointment: McpToolDefinition<typeof marcarShape> = {
  name: "crm_book_appointment",
  description:
    "Marca um compromisso com HORA COMBINADA entre o cliente e um atendente — consulta, sessão, " +
    "visita, reunião. Use quando o cliente ESCOLHEU um horário e vai comparecer: isto reserva o " +
    "tempo de uma pessoa da equipe, e o cliente conta com ele. No atendimento atual, marcar Google Meet também agenda a entrega do link nesta conversa quando ficar pronto. " +
    "NÃO use para 'voltar a falar com o cliente depois' — isso é retorno, e a ferramenta é " +
    "`crm_schedule_followup`. A diferença: aqui as DUAS partes combinaram e alguém vai esperar; " +
    "lá é decisão interna nossa e o cliente não sabe de nada. " +
    "Chame `crm_find_free_slots` ANTES e use um `starts_at` que veio de lá — marcar em horário que " +
    "não está livre é recusado, e a recusa manda você consultar de novo. " +
    "⚠️ Alguns atendimentos exigem que uma pessoa da equipe aprove: nesses, o horário fica " +
    "RESERVADO e o retorno traz `aguarda_confirmacao: true`. Quando vier assim, NÃO diga que está " +
    "confirmado — diga que separou o horário e que a equipe confirma.",
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
        { organization_id: ctx.organizationId, actor: ctx.actor, requestId: ctx.requestId, meetingBooking: ctx.meetingBooking },
        {
          event_type_id: tipo.id,
          starts_at: input.starts_at,
          contact_id: input.contact_id,
          ...(input.owner_user_id ? { owner_user_id: input.owner_user_id } : {}),
          ...(input.title ? { title: input.title } : {}),
          ...(input.notes ? { notes: input.notes } : {}),
          ...(input.description ? { description: input.description } : {}),
          ...(input.location_details !== undefined
            ? { location_details: input.location_details }
            : {}),
        },
      );
      /**
       * ⚠️ MARCADO NÃO É CONFIRMADO, e o modelo precisa ouvir isso em voz alta.
       *
       * Um tipo com `requires_confirmation` nasce `pending`: o horário fica
       * RESERVADO (some da lista de livres, e outra marcação no mesmo horário é
       * recusada), mas alguém da equipe ainda precisa dizer sim. É o arranjo de
       * quem quer que uma pessoa aprove cada atendimento.
       *
       * Até aqui, a única pista disso era `status: "pending"` enterrado dentro
       * de `compromisso` — enquanto a descrição desta tool diz "o cliente conta
       * com ele" e o bloco de sistema da agenda manda o modelo dizer que está
       * confirmado depois de marcar. O produto ENSINAVA o modelo a afirmar
       * "está marcado!" num compromisso que ainda podia ser recusado, e o
       * cliente ouviria uma confirmação que ninguém deu.
       *
       * Os dois "pending" deste retorno são coisas diferentes e coincidem no
       * nome: `status` é o do compromisso, `meeting_state` é o do link do Meet.
       * Por isso as mensagens são separadas e nomeadas.
       */
      const aguardaConfirmacao = r.status === "pending";
      const avisos = [
        aguardaConfirmacao
          ? "O horário ficou RESERVADO para esta pessoa, e ninguém mais consegue pegá-lo — mas " +
            "ainda NÃO está confirmado: alguém da equipe precisa aprovar. Não diga que está " +
            "confirmado, marcado ou garantido. Diga que o horário foi separado e que a equipe " +
            "confirma."
          : null,
        r.meeting_state === "pending"
          ? "O link ainda está sendo criado. Não invente um link nem afirme que ele já foi enviado."
          : null,
      ].filter(Boolean);

      return {
        marcado: true,
        compromisso: r,
        // Campo próprio, além da mensagem: um booleano no topo é o que o modelo
        // enxerga sem precisar interpretar prosa.
        aguarda_confirmacao: aguardaConfirmacao,
        ...(avisos.length > 0 ? { mensagem: avisos.join(" ") } : {}),
      };
    }),
};

/**
 * O caminho de MARCAÇÃO de quem já TEM a hora na mão — usado pela ferramenta que
 * só marca (`crm_book_appointment`) e pela que consulta E marca numa chamada só
 * (`crm_find_and_book_appointment`, issue #831).
 *
 * ⚠️ Delega para o handler REGISTRADO de `crm_book_appointment` em vez de repetir
 * as chamadas: é a MESMA marcação, com a mesma reserva de horário, o mesmo
 * `aguarda_confirmacao` e a mesma recusa de negócio. Uma segunda implementação
 * aqui divergiria da primeira na primeira mudança, e o sintoma seria o mesmo
 * horário marcar de um jeito numa ferramenta e de outro na outra.
 */
async function marcarHorario(
  ctx: McpContext,
  args: {
    eventTypeSlug: string;
    startsAt: string;
    contactId: string;
    ownerUserId?: string;
    title?: string;
    notes?: string;
  },
): Promise<unknown> {
  return crmBookAppointment.handler(
    {
      event_type_slug: args.eventTypeSlug,
      starts_at: args.startsAt,
      contact_id: args.contactId,
      ...(args.ownerUserId !== undefined ? { owner_user_id: args.ownerUserId } : {}),
      ...(args.title !== undefined ? { title: args.title } : {}),
      ...(args.notes !== undefined ? { notes: args.notes } : {}),
    },
    ctx,
  );
}

const consultarEMarcarShape = {
  event_type_slug: z.string().min(1).describe("o identificador legível do tipo de atendimento"),
  dia: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "dia deve estar em YYYY-MM-DD")
    .describe(
      "o dia CIVIL que o cliente pediu, em YYYY-MM-DD. O servidor aplica o fuso da agenda: " +
        "nunca some nem subtraia horas para \"corrigir\" o fuso.",
    ),
  horario: z
    .string()
    .regex(/^\d{1,2}:\d{2}$/, "horario deve estar em HH:mm")
    .describe(
      "a HORA LOCAL que o cliente pediu no mesmo dia do campo `dia`, em HH:mm (ex.: \"14:00\"). " +
        "É a hora que aparece em `quando` na consulta — a mesma do relógio de quem atende.",
    ),
  contact_id: z.string().uuid().describe("quem vai ser atendido"),
  owner_user_id: z.string().uuid().optional(),
  title: z.string().min(1).max(200).optional(),
  notes: z.string().max(2000).optional(),
};

/**
 * CONSULTA E MARCAÇÃO NUMA CHAMADA SÓ (issue #831).
 *
 * O sintoma que esta ferramenta existe para matar: o cliente diz "quinta às 14h",
 * o modelo chama `crm_find_free_slots`, recebe a lista e encerra o turno achando
 * que combinou — ninguém marcou nada. Consultar e marcar são a MESMA decisão
 * quando o cliente já disse dia E hora: separá-las em duas idas ao modelo cria a
 * chance (e a prática) de parar no meio.
 *
 * Duas promessas do contrato:
 *  1. NADA é marcado sem estar livre — a lista de livres decide, não a palavra do
 *     modelo. O horário que a ferramenta marca é `inicio` do slot encontrado, não
 *     o que o modelo digitou.
 *  2. Recusa NUNCA volta como exceção (e nada fica pela metade): se o horário não
 *     está livre, a resposta traz `marcado: false` MAIS os horários daquele dia,
 *     para o modelo oferecer as alternativas reais no mesmo turno em vez de pedir
 *     outro dia no escuro.
 */
export const crmFindAndBookAppointment: McpToolDefinition<typeof consultarEMarcarShape> = {
  name: "crm_find_and_book_appointment",
  description:
    "Confere UM horário e, se estiver livre, MARCA na MESMA chamada. Use quando o cliente " +
    "JÁ disse o dia E a hora (\"quinta às 14h\", \"amanhã de manhã às 9\") e esse par ainda não " +
    "foi checado: aqui consulta e marcação são uma decisão só, e é o caminho preferido — " +
    "encerrar o turno com o horário apenas consultado deixa o cliente sem agendamento. " +
    "Não use quando o cliente ainda não escolheu hora (aí é `crm_find_free_slots`) nem para " +
    "voltar a falar com ele depois (é `crm_schedule_followup`). " +
    "Se o horário NÃO estiver livre, NADA é marcado: a resposta traz `marcado: false` e a lista " +
    "`horarios` daquele dia — ofereça uma dessas opções ao cliente, não peça outro dia sem " +
    "mostrar o que existe. " +
    "O horário marcado é o que a agenda confirmou como livre, então use `inicio`/`quando` do " +
    "retorno ao falar com a pessoa. " +
    "⚠️ Alguns atendimentos exigem aprovação da equipe: nesses o retorno traz " +
    "`aguarda_confirmacao: true` — diga que separou o horário e que a equipe confirma, nunca que " +
    "está confirmado.",
  inputSchema: consultarEMarcarShape,
  category: "write",
  requiresRole: "ai_operator",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const agora = new Date();
    const { de, ate } = faixaAmplaDoDia(input.dia);

    const consulta = await horariosLivresDaOrg(ctx.supabase, ctx.organizationId, {
      eventTypeSlug: input.event_type_slug,
      ownerUserId: input.owner_user_id ?? null,
      de,
      ate,
      agora,
    });

    // A recusa de NEGÓCIO da própria consulta (tipo desconhecido, atendente sem
    // jornada, agenda ilegível) volta como RESPOSTA: exceção mataria o turno e o
    // cliente ficaria sem ninguém (`repo-mcp.md` §7.5).
    if (!consulta.ok) {
      return {
        marcado: false,
        horarios: [],
        motivo: consulta.codigo,
        // A face do CLIENTE, nunca a do operador (DECISÃO 20).
        mensagem: consulta.motivoParaCliente,
      };
    }

    const slotsDoDia = consulta.slots.filter(
      (s) => diaLocalISO(s.inicio, consulta.fusoDaRegra) === input.dia,
    );
    const pedido = normalizarHorario(input.horario);
    // A comparação é entre o RÓTULO que a consulta publica e a hora que o cliente
    // falou — a mesma régua, o mesmo fuso. Comparar `Date` contra texto, ou usar
    // o fuso do processo, é o defeito que faria a ferramenta recusar 14:00 numa
    // agenda que tem 14:00.
    const achado = slotsDoDia.find(
      (s) => horaLocalDoRotulo(rotuloLocal(s.inicio, consulta.fusoDaRegra)) === pedido,
    );

    if (achado === undefined) {
      return {
        ...payloadDeHorarios(consulta, slotsDoDia, HORARIOS_PADRAO),
        marcado: false,
        motivo: "horario_indisponivel",
        // O tom importa: o cliente não fez nada errado, e "não está livre" NÃO é
        // "não existe". A instrução é oferecer o que a agenda tem.
        mensagem:
          `${pedido} não está livre em ${input.dia}, e NADA foi marcado. Ofereça ao cliente uma ` +
          "das opções de `horarios` (é o que a agenda realmente tem nesse dia); se a lista " +
          "vier vazia, ofereça consultar outro dia com `crm_find_free_slots`.",
      };
    }

    const resultado = await marcarHorario(ctx, {
      eventTypeSlug: input.event_type_slug,
      // O instante vem do SLOT, não do que o modelo escreveu: é o horário que a
      // agenda confirmou como livre.
      startsAt: achado.inicio.toISOString(),
      contactId: input.contact_id,
      ...(input.owner_user_id !== undefined ? { ownerUserId: input.owner_user_id } : {}),
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    });

    const recusado =
      typeof resultado === "object" &&
      resultado !== null &&
      (resultado as { marcado?: unknown }).marcado === false;

    if (recusado) {
      // A marcação foi recusada depois de o horário estar livre (aprovação
      // interna, conflito de última hora, erro de negócio). O turno continua, e
      // a resposta junta a recusa ao que estava livre no dia: é o material que o
      // modelo precisa para não encerrar a conversa com o cliente na mão.
      //
      // ⚠️ A lista vai SEM o horário recusado: ele acabou de ser recusado, e
      // oferecê-lo de volta ao cliente é o começo de um laço.
      const payload = payloadDeHorarios(
        consulta,
        slotsDoDia.filter((s) => s !== achado),
        HORARIOS_PADRAO,
      );
      // ⚠️ E o ensino só é REESCRITO quando a recusa é o horário que ficou
      // indisponível e SOBROU opção no dia. O texto de `ENSINO_POR_CODIGO` para
      // esse código é o da marcação avulsa — "chame `crm_find_free_slots` de
      // novo" —, que aqui é um laço: a lista do dia já está nesta resposta.
      //
      // Reescrever SEMPRE, como uma versão anterior fazia, apagava o ensino
      // certo das outras recusas: `agenda_disponibilidade_invalida` diz "não
      // ofereça horários", `agenda_tipo_desativado` diz "pergunte que outro
      // atendimento serve" — e as duas passavam a mandar oferecer um horário da
      // lista. E sem opção no dia, consultar outro dia é mesmo o próximo passo.
      const motivoDaRecusa = (resultado as { motivo?: unknown }).motivo;
      const ofereceDaLista =
        motivoDaRecusa === "agenda_horario_indisponivel" && payload.horarios.length > 0;
      return {
        ...payload,
        ...(resultado as Record<string, unknown>),
        ...(ofereceDaLista
          ? {
              mensagem:
                "esse horário acabou de ficar indisponível e NADA foi marcado. Ofereça ao cliente uma " +
                "das opções de `horarios` desta mesma resposta — não chame a consulta de novo.",
            }
          : {}),
      };
    }

    return {
      ...(resultado as Record<string, unknown>),
      // O horário que ESTA chamada usou, explícito: o modelo não precisa deduzir
      // de dentro de `compromisso` o que ele mesmo pediu.
      inicio: achado.inicio.toISOString(),
      quando: rotuloLocal(achado.inicio, consulta.fusoDaRegra),
      agenda_externa_nunca_lida: consulta.agendaExternaNuncaLida,
      // ⚠️ A ressalva vai JUNTO da confirmação, e concatenada — não por cima. O
      // texto que `resultado` traz é o da marcação ("marquei tal dia"), e é ele
      // que o modelo repete ao cliente; sobrescrever perderia o que foi marcado.
      // Recusar a marcação nesse estado é decisão do dono do produto, não um
      // ajuste de consistência: hoje a ferramenta marca.
      ...(consulta.agendaExternaNuncaLida
        ? { mensagem: comRessalvaDeAgendaNuncaLida(resultado) }
        : {}),
    };
  },
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
    "Propõe à equipe registrar comparecimento ou falta depois do início do compromisso. " +
    "A presença exige confirmação humana na Agenda; texto interpretado pelo assistente não é autorização. " +
    "Se a pessoa avisou que não vem, use crm_cancel_appointment para o cancelamento operacional.",
  inputSchema: desfechoShape,
  category: "write",
  requiresRole: "ai_operator",
  requiresScope: "mcp:write",
  handler: async (input, ctx) =>
    semDerrubarOTurno("registrado", async () => {
      if (ctx.actor.type !== "user") return { registrado: false, requer_confirmacao_humana: true,
        orientacao: "Peça à equipe para abrir o compromisso na Agenda e confirmar a presença.",
        href: `/app/agenda?compromisso=${input.appointment_id}` };
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
