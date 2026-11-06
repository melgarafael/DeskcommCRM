/**
 * Espelho do avanço de funil no kanban do CRM — LIGADO. O harness (lead_state) é
 * a fonte da verdade do funil do agente; quando o agente avança um passo, o card
 * do tenant anda junto no board, traduzido pelo `crm_stages.agent_stage_hint`.
 *
 * ⚠️ Este arquivo NÃO decide qual negócio do contato se move: ele DELEGA para
 * `sincronizaEstagioDoAgente`, que reusa o `resolveActiveLeadForContact` da wave
 * 4. Um segundo resolvedor aqui seriam duas fontes que começam iguais e divergem
 * no primeiro ajuste.
 *
 * Cada não-movimento vira o rótulo que diz a verdade sobre ele (ver MIRROR_WARN_ONLY):
 * configuração e conflito com humano são estado normal (warn-only); perda sem
 * motivo é estado normal MAS precisa de item de inbox (falta ação do humano); e
 * banco fora / escrita falha são incidente — os dois últimos abrem item no caller.
 */
import { sincronizaEstagioDoAgente } from '@/lib/leads/agent-stage-sync';
import { insertInboxItem, type InboxDedupe } from '../../db/repository';
import type { Queryable } from '../../queue/queue';
import type { CrmEdgeConfig } from './mcp-client';
import type { LeadStage } from '../../agent/lead-state';

export type MirrorReason =
  | 'not_configured'
  | 'human_conflict'
  /**
   * O negócio está num funil que este agente não cuida (spec 17 passo 3).
   *
   * ⚠️ FORA de MIRROR_WARN_ONLY, de propósito. É estado legítimo do produto —
   * mas no dia 1 de cada agente ele é 100% dos movimentos, e um veto silencioso
   * em massa se lê como "a IA parou de funcionar". O aviso é o que transforma
   * uma proteção num fato compreensível.
   */
  | 'fora_do_escopo'
  /**
   * A etapa de destino é de PERDA e o motivo da perda é do humano (issue #917).
   *
   * ⚠️ FORA de MIRROR_WARN_ONLY, e por uma razão diferente da de
   * `fora_do_escopo`: não é estado que se resolve sozinho com paciência — o
   * negócio que o agente quis fechar como perdido CONTINUA aberto, e o dono
   * precisa saber que a IA parou ali e por quê. Warn silencioso deixaria o card
   * parado num funil que parece só atrasado. O item de inbox é o ensinamento:
   * marque como perdido e informe o motivo (o banco recusa motivo que o agente invente).
   */
  | 'perda_sem_motivo'
  /**
   * A etapa de destino exige CAMPOS que o negócio não tem (issue #1536).
   *
   * ⚠️ FORA de MIRROR_WARN_ONLY, pelo MESMO motivo de `perda_sem_motivo`: não é
   * incidente (nada quebrou, a régua funcionou) e não é estado que se resolve
   * sozinho — o card parou num funil que pede dado, e o dono precisa saber QUAL
   * dado falta. O `detalhe` vem de `recusaDeCamposObrigatorios`, com os rótulos.
   */
  | 'campos_obrigatorios'
  | 'crm_error'
  | 'crm_unavailable';

export type MirrorResult =
  | { ok: true }
  | {
      ok: false;
      reason: MirrorReason;
      detail: string;
      /**
       * O NOME da etapa de destino no funil do DONO (issue #3148), quando o
       * resolvedor o conhece.
       *
       * ⚠️ Distinto do passo interno do agente: `toStage`/`update.transition.to`
       * é vocabulário da máquina de estados do atendimento ("lost",
       * "qualifying"), enquanto `stageName` é o rótulo que o dono cadastrou no
       * quadro ("Perdido", "Proposta enviada"). O aviso da Central nomeia a etapa
       * do funil; o passo interno só serve ao log e ao ramo de incidente.
       *
       * Ausente na recusa de ESCOPO, que decide ANTES de ler as etapas — e é
       * exatamente por isso que o aviso tem um texto de reserva legível, sem
       * vazar o rótulo interno.
       */
      stageName?: string;
      /**
       * O NEGÓCIO (`crm_leads.id`) que o sync resolveu para o contato, quando
       * chegou a resolver. É ele — e não o contato — que o aviso da Central
       * referencia: a Central procura `ref_kind = 'lead'` em `crm_leads`, e com o
       * id do contato o aviso abria "Este contexto não está disponível".
       */
      negocioId?: string;
    };

/**
 * Os não-movimentos que são ESTADO LEGÍTIMO do produto: warn no log do run, sem
 * item de inbox. O que fica de fora (crm_error, crm_unavailable) é incidente de
 * verdade — o funil parou e alguém precisa saber. Um rótulo honesto de cada lado
 * é o que impede o inbox de virar ruído que o usuário aprende a ignorar.
 */
export const MIRROR_WARN_ONLY: ReadonlySet<MirrorReason> = new Set<MirrorReason>([
  'not_configured',
  'human_conflict',
]);

/** O aviso que vai para a Central quando o espelho recusa — `null` = warn-only. */
export interface AvisoDoEspelho {
  title: string;
  body: string;
  /**
   * Como NÃO abrir outro igual enquanto o primeiro está aberto.
   *
   * Mora na DECISÃO e não no ponto de uso porque é a mesma classe de coisa que o
   * texto: o assistente reconclui o mesmo passo a cada turno, e sem dedupe nasce
   * uma linha por mensagem do cliente — N cópias enterram o item que pedia
   * decisão. Escolher isto no `if` do chamador é escolher onde ninguém consegue
   * afirmar sobre a escolha.
   */
  dedupe: InboxDedupe;
}

/**
 * O dedupe dos dois avisos do espelho: (kind, ref, título).
 *
 * ⚠️ `kind_e_ref` NÃO serve, e a razão está nos dois returns abaixo: os dois
 * avisos saem com o mesmo `kind` genérico (`other`) e a mesma `ref` (o lead),
 * distinguidos só pelo TÍTULO. Por `kind_e_ref` o segundo sumiria atrás do
 * primeiro; por `kind_e_titulo` o aviso de um lead calaria o do lead seguinte.
 */
const DEDUPE_DO_ESPELHO: InboxDedupe = 'kind_ref_e_titulo';

/**
 * COMO O AVISO NOMEIA A ETAPA DE DESTINO — o nome que está no funil do DONO.
 *
 * ⚠️ NUNCA o passo interno do agente (issue #3148). Medido na issue: a Central
 * abria `...deveria ir para "lost"`, e quem lê o aviso conhece só o nome que ele
 * mesmo cadastrou no quadro ("Perdido"). O passo interno é vocabulário da máquina
 * de estados do atendimento — serve ao `runLog.warn` (`to_stage`) e ao ramo de
 * INCIDENTE, que é diagnóstico de quem depura, e nunca ao texto para humano.
 *
 * Sem nome resolvido, o aviso fala da etapa por extenso em vez de vazar o rótulo
 * interno ou sair vazio. Acontece na recusa de ESCOPO, que decide ANTES de ler as
 * etapas — não há consulta nova ao CRM só para nomear (ver `sincronizaEstagioDoAgente`).
 *
 * O nome entra como ESTÁ cadastrado (respeita maiúscula/acento do tenant): traduzir
 * ou normalizar aqui seria inventar um rótulo que o dono não reconhece no quadro.
 */
function etapaComoOChamadorLe(etapaDoFunil: string | undefined): string {
  const nome = etapaDoFunil?.trim();
  return nome !== undefined && nome.length > 0 ? `"${nome}"` : 'a etapa de destino do funil';
}

/**
 * QUAL aviso o não-movimento produz — a decisão, separada de quem a grava.
 *
 * ⚠️ Ela mora AQUI, e não no `inbound-turn`, por um motivo medido: enquanto o
 * encadeado de `if` ficou no ponto de uso, apagar o ramo de `perda_sem_motivo`
 * inteiro deixava ZERO teste vermelho — a execução caía no ramo genérico, que
 * também grava um item, e a sabotagem passava despercebida. Só que o item
 * genérico diz "Espelho de stage no CRM falhou — funil possivelmente
 * inconsistente / Reconcilie o stage no CRM manualmente", que é exatamente a
 * mensagem de incidente que a issue #917 existe para eliminar: nada quebrou, e
 * quem lê isso vai procurar um defeito que não existe.
 *
 * Dois ramos que gravam um item cada, com textos opostos, não se distinguem por
 * "houve item?". Distinguem-se pelo TEXTO — e texto só vira asserção quando a
 * decisão é uma função que se pode chamar.
 */
export function avisoDoEspelhoRecusado(input: {
  motivo: MirrorReason;
  detalhe: string;
  /**
   * O PASSO INTERNO do agente para onde ele quis levar o negócio
   * (`update.transition.to`: "lost", "qualifying").
   *
   * ⚠️ NÃO é o texto para humano (issue #3148): os avisos de estado legítimo
   * nomeiam a etapa do funil via `etapaDoFunil`. Este campo fica para o ramo de
   * INCIDENTE, onde o rótulo interno é diagnóstico de quem depura o funil quebrado.
   */
  etapaDeDestino: string;
  /**
   * O NOME da etapa no funil do DONO (issue #3148) — o que o aviso mostra.
   *
   * Ausente quando o resolvedor não o conhece (recusa de ESCOPO, que decide antes
   * de ler as etapas): cai no texto de reserva legível, nunca no passo interno.
   */
  etapaDoFunil?: string;
}): AvisoDoEspelho | null {
  const { motivo, detalhe, etapaDeDestino, etapaDoFunil } = input;

  if (motivo === 'fora_do_escopo') {
    // Aviso PRÓPRIO, e não o de falha: nada quebrou — a regra funcionou. Dizer
    // "falhou" aqui mandaria o dono procurar um defeito que não existe, e
    // "reconcilie manualmente" seria instrução errada: ele não deve mover o
    // card, deve decidir se libera o funil para este assistente.
    return {
      title: 'O assistente quis organizar um negócio de um funil que não é dele',
      body:
        `O assistente concluiu que este negócio deveria ir para ${etapaComoOChamadorLe(etapaDoFunil)}, ` +
        `mas ele não cuida do funil onde o negócio está (${detalhe}). ` +
        `Ninguém mexeu no card. Se ele deveria cuidar desse funil, marque isso na ` +
        `configuração do assistente; se não, não há nada a fazer.`,
      dedupe: DEDUPE_DO_ESPELHO,
    };
  }

  if (motivo === 'perda_sem_motivo') {
    // ── A ETAPA DE PERDA EXIGE MOTIVO (issue #917) ──────────────────────────
    // O assistente avançou o funil dele para uma etapa que, no funil do
    // cliente, fecha o negócio como PERDIDO — e perder exige um motivo, que é a
    // causa que quem está no negócio reconhece.
    //
    // ⚠️ O motivo NÃO é escrito pela IA, e não é falha de coragem: o banco
    // recusa motivo fora do vocabulário do funil (22023), então um motivo
    // escolhido aqui seria recusado — ou, pior, passaria colado num dos
    // canônicos e gravaria no funil do cliente uma causa que ninguém afirmou. O
    // card NÃO se move, nada quebrou, e o que falta é uma AÇÃO DO HUMANO — nem
    // warn silencioso (o card ficaria parado sem ninguém saber por quê) nem o
    // aviso de falha (mandaria o dono procurar um defeito que não existe).
    return {
      title: 'O assistente quis marcar um negócio como perdido — e isso exige um motivo',
      body:
        `O assistente concluiu que este negócio deveria ir para ${etapaComoOChamadorLe(etapaDoFunil)}, ` +
        `que no seu funil é uma etapa de perda. Perder um negócio exige um motivo, e o ` +
        `motivo é a razão que quem está no negócio reconhece — o assistente não inventa ` +
        `uma. Ninguém mexeu no card: ele continua onde estava. Se o negócio realmente se ` +
        // ⚠️ "Marcar como perdido", e não "mova o card": ARRASTAR para a etapa de
        // perda não pede o motivo — o quadro devolve o card e avisa "Informe o
        // motivo da perda.". Quem seguisse a instrução antiga batia nessa recusa. A
        // ação do menu do card é a que pergunta o motivo, e leva à mesma etapa
        // (só há uma etapa de perda por funil).
        `perdeu, abra o card no funil, use "Marcar como perdido" e informe o motivo; ` +
        `se não, não há nada a fazer.`,
      dedupe: DEDUPE_DO_ESPELHO,
    };
  }

  if (motivo === 'campos_obrigatorios') {
    // ── A ETAPA DE DESTINO EXIGE CAMPOS (issue #1536) ────────────────────────
    // O assistente avançou o funil dele para uma etapa do funil do cliente que
    // declara `obrigatorio_em` — e o negócio não tem o campo preenchido. É o
    // mesmo desenho da perda sem motivo: nada quebrou, a régua funcionou, o card
    // não andou e o que falta é uma AÇÃO DO HUMANO (preencher no dossiê).
    // Warn silencioso deixaria o card parado sem ninguém saber por quê; aviso de
    // incidente mandaria o dono procurar um defeito que não existe. O `detalhe`
    // é a frase da própria régua, com os rótulos do que falta.
    return {
      title: 'O assistente quis mover um negócio — o funil exige campos antes',
      body:
        `O assistente concluiu que este negócio deveria ir para ${etapaComoOChamadorLe(etapaDoFunil)}, ` +
        `mas o seu funil exige o preenchimento de alguns campos antes de entrar nela. ` +
        `${detalhe} Ninguém mexeu no card: ele continua onde estava. Abra o negócio, ` +
        `preencha o que falta no dossiê e mova o card normalmente.`,
      dedupe: DEDUPE_DO_ESPELHO,
    };
  }

  if (MIRROR_WARN_ONLY.has(motivo)) return null;

  return {
    title: 'Espelho de stage no CRM falhou — funil possivelmente inconsistente',
    // ⚠️ AQUI o passo interno PODE continuar (issue #3148): este é o ramo de
    // INCIDENTE, e `lead_state avançou para "lost"` é diagnóstico de quem depura
    // — qual passo do agente pediu o movimento e não foi atendido. O texto de
    // humano dos três avisos de estado legítimo é que nunca mostra o rótulo interno.
    body: `lead_state avançou para "${etapaDeDestino}" no harness, mas crm_move_lead_stage falhou (${motivo}: ${detalhe}). Reconcilie o stage no CRM manualmente.`,
    // Incidente TAMBÉM deduplica: o funil quebrado se repete a cada turno, e mil
    // cópias do mesmo incidente escondem o resto da Central tão bem quanto mil
    // cópias de um aviso rotineiro.
    dedupe: DEDUPE_DO_ESPELHO,
  };
}

/**
 * Abre na Central o aviso do espelho recusado — a decisão E a gravação, juntas.
 *
 * ⚠️ Existe porque separar as duas deixava o ponto de uso sem guarda. Com
 * `avisoDoEspelhoRecusado` testável e o `insertInboxItem` escrito à mão no
 * `inbound-turn`, apagar o quarto argumento da chamada (o `dedupe`) voltava a
 * abrir uma linha por turno — e nenhum teste via: o invariante chama
 * `insertInboxItem` direto, com o `dedupe` que ELE lê da decisão, nunca com o
 * que o `inbound-turn` passa. Aqui não há o que esquecer no chamador: ele passa
 * o motivo e o lead, e o resto (kind, ref, texto, dedupe) sai de um lugar só.
 */
export async function abreAvisoDoEspelhoRecusado(
  db: Parameters<typeof insertInboxItem>[0],
  tenantId: string,
  input: {
    /**
     * O NEGÓCIO que o espelho resolveu (`MirrorResult.negocioId`). Ausente quando
     * o sync não chegou a resolver um (banco fora, exceção): aí o aviso sai SEM
     * referência — o id do contato com o rótulo `lead` apontava para uma linha
     * que não existe em `crm_leads`, e referência errada é pior que nenhuma.
     */
    negocioId?: string;
    motivo: MirrorReason;
    detalhe: string;
    /**
     * O PASSO INTERNO do agente (`update.transition.to`) — só diagnóstico de
     * incidente, nunca o texto para humano (issue #3148).
     */
    etapaDeDestino: string;
    /** O NOME da etapa no funil do dono — o que o aviso mostra (issue #3148). */
    etapaDoFunil?: string;
  },
): Promise<void> {
  const aviso = avisoDoEspelhoRecusado(input);
  // `null` é warn-only: estado legítimo do produto não vira item na Central.
  if (aviso === null) return;
  const ref = input.negocioId !== undefined ? { refKind: 'lead', refId: input.negocioId } : {};
  await insertInboxItem(
    db,
    tenantId,
    { kind: 'other', title: aviso.title, body: aviso.body, ...ref },
    aviso.dedupe,
  );
}

/** Injetável só para teste — em produção é sempre a implementação real. */
interface Deps {
  sync?: typeof sincronizaEstagioDoAgente;
}

export async function mirrorLeadStageToCrm(
  _db: Queryable,
  cfg: CrmEdgeConfig,
  input: {
    tenantId: string;
    leadId: string;
    toStage: LeadStage;
    reason?: string;
    /** Funis autorizados na versão publicada; ausente só no caminho legado. */
    pipelineIds?: readonly string[];
  },
  deps: Deps = {},
): Promise<MirrorResult> {
  const sync = deps.sync ?? sincronizaEstagioDoAgente;
  try {
    // `input.leadId` é o contact_id do CRM: o funil do agente é por CONTATO
    // (lead_state.contact_id) e quem resolve "qual negócio deste contato" é o
    // `resolveActiveLeadForContact` lá dentro — não aqui.
    const r = await sync(cfg.supabase, {
      organizationId: input.tenantId,
      contactId: input.leadId,
      passo: input.toStage,
      ...(input.pipelineIds !== undefined ? { escopoDeFunis: input.pipelineIds } : {}),
    });

    if (r.moveu || r.motivo === 'ja_esta_la') return { ok: true };

    // Cada motivo vira o rótulo que DIZ A VERDADE sobre ele. Os três primeiros
    // são configuração/estado normal (warn-only, sem inbox); `conflito_humano`
    // também não é incidente — o humano venceu a corrida e a decisão dele vale —
    // mas chamá-lo de `not_configured` mentiria sobre a causa para quem lê o log.
    // Banco fora e escrita falha SÃO incidentes: viram item de inbox no caller.
    const traduz: Record<string, { reason: MirrorReason; detail: string }> = {
      sem_mapeamento: {
        reason: 'not_configured',
        detail: `nenhum estágio do pipeline declara agent_stage_hint = "${input.toStage}"`,
      },
      sem_negocio: { reason: 'not_configured', detail: 'o contato não tem negócio aberto para mover' },
      // O detalhe vem do sync (distingue "nenhum funil liberado" de "funil de
      // outro time") e é o que o aviso na Central mostra ao dono.
      fora_do_escopo: {
        reason: 'fora_do_escopo',
        detail: 'este assistente não cuida do funil onde o negócio está',
      },
      perda_sem_motivo: {
        reason: 'perda_sem_motivo',
        detail: 'a etapa de destino fecha o negócio como perdido, e perder exige um motivo que o assistente não pode escolher',
      },
      // O `detalhe` do sync VENCE (linha abaixo) — ele já vem com os rótulos do
      // que falta, tirados da mesma função que monta os 422 das rotas.
      campos_obrigatorios: {
        reason: 'campos_obrigatorios',
        detail: 'a etapa de destino exige campos que o negócio não tem preenchidos',
      },
      ambiguo: {
        reason: 'not_configured',
        detail: 'o contato tem mais de um negócio aberto — nenhum foi movido',
      },
      conflito_humano: {
        reason: 'human_conflict',
        detail: 'um humano moveu o card durante a operação — a decisão dele prevalece',
      },
      falha_de_escrita: {
        reason: 'crm_error',
        detail: `o UPDATE do card falhou: ${r.detalhe ?? 'sem detalhe'}`,
      },
      indisponivel: {
        reason: 'crm_unavailable',
        detail: `o banco do CRM não respondeu: ${r.detalhe ?? 'sem detalhe'}`,
      },
    };
    const t = traduz[r.motivo];
    // O nome da etapa do FUNIL acompanha a recusa quando o resolvedor o conhece
    // (issue #3148) — é ele que o aviso da Central mostra. Sem isto, o caller só
    // teria o passo interno (`toStage`) à mão e o difundiria ao dono.
    const comNome = r.stageName !== undefined ? { stageName: r.stageName } : {};
    const negocio = r.leadId !== undefined ? { negocioId: r.leadId } : {};
    // O `detalhe` do sync VENCE o texto genérico da tabela quando existe: ele
    // sabe QUAL dos dois casos de escopo aconteceu, e o dono precisa dessa
    // diferença para saber se marca um funil ou não faz nada.
    if (t && r.detalhe) return { ok: false, reason: t.reason, detail: r.detalhe, ...negocio, ...comNome };
    // Motivo desconhecido NÃO pode virar warn-only silencioso: rótulo novo sem
    // tradução aqui é bug de programação, e o inbox é onde ele aparece.
    if (!t) return { ok: false, reason: 'crm_error', detail: `motivo não traduzido: ${r.motivo}`, ...negocio };
    return { ok: false, ...t, ...negocio, ...comNome };
  } catch (err) {
    return {
      ok: false,
      reason: 'crm_error',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
