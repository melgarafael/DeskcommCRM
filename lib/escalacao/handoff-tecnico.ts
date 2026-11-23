/**
 * Handoff causado por DERIVAÇÃO AUSENTE (#2210) — a marca que separa falha de
 * infraestrutura de decisão humana, e a reação quando a causa passa.
 *
 * O problema medido: dois áudios entraram sem saldo, a derivação falhou com 429
 * e reagendou; o turno rodou sem o texto, o modelo declarou "não há transcrição
 * de texto disponível no sistema" e passou a conversa para humano
 * (`bot_silenced_until = 'infinity'`, `force_human = true`). Quinze minutos
 * depois a derivação entregou (`media_derived_status = 'ready'`) e nada
 * reavaliou — o motivo gravado seguia afirmando o que o próprio banco desmentia,
 * e a conversa só saía do silêncio pelo botão "Devolver ao automático".
 *
 * A FATIA (do corpo da issue):
 *   1. o motivo gravado não pode seguir afirindo algo que o banco já desmentiu;
 *   2. falha transitória de infraestrutura não vira estado permanente: quando a
 *      derivação conclui, a conversa volta a ser atendida sem intervenção manual.
 *
 * O handoff por DECISÃO humana — pedido explícito, opt-out, "Assumir eu",
 * sentimento, pausa manual — continua `infinity`: ele é T18 e não entra aqui.
 *
 * Por que a marca existe em `conversations.metadata` (sem migration, campo que
 * já existe): "causado por derivação ausente" não é consultável em nenhum
 * lugar — `last_handoff_reason` é texto livre escrito pelo modelo. A marca
 * grava juntos o `message_id` (cuja derivação estava aberta) e o
 * `motivo_gravado` EXATO: é o motivo que amarra a marca ao handoff atual, então
 * um handoff posterior, por outro motivo, invalida a marca sozinho, sem precisar
 * varrer os demais escritores de `last_handoff_*`.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "@/lib/logger";
import { DERIVACAO_TERMINADA } from "@/lib/messaging/media/derivable";
import { devolverAtendimentoAoAgente } from "@/lib/escalacao/retomada";

/** Chave do objeto dentro de `conversations.metadata`. */
export const CHAVE_DO_HANDOFF_TECNICO = "handoff_tecnico";

/** `bot_silenced_until` do handoff formal — o mesmo valor do botão e da cron. */
const SILENCIO_FORMAL = "infinity";

/** Estados que ainda voltam ao automático (mesmo critério da cron de devolução). */
const STATUS_QUE_VOLTA_AO_AUTOMATICO: ReadonlySet<string> = new Set([
  "open",
  "pending",
  "claimed",
  "ai_handling",
]);

export interface MarcaDeHandoffTecnico {
  causa: "derivacao_ausente";
  message_id: string;
  /** O `last_handoff_reason` gravado junto com a marca — ver docstring. */
  motivo_gravado: string;
  marcado_em: string;
  resolvido_em?: string;
}

/** A marca é escrita só quando a derivação daquela mensagem ainda estava ABERTA. */
export interface MensagemComDerivacao {
  media_url: string | null;
  media_derived_status: string | null;
}

/**
 * `ready`, `failed` e `skipped` são estados finais: não há o que esperar.
 *
 * `failed` terminal NÃO marca — a causa ("não há transcrição") continua sendo
 * verdadeira e o handoff legítimo permanece. A marca existe para o caso que se
 * resolve sozinho.
 */
export function derivacaoAindaEmAberto(mensagem: MensagemComDerivacao | null | undefined): boolean {
  if (!mensagem) return false;
  if (!mensagem.media_url) return false;
  return !DERIVACAO_TERMINADA.has(mensagem.media_derived_status ?? "");
}

/**
 * #2210 — a mensagem que disparou o turno ainda tinha a derivação em aberto?
 *
 * É a única consulta do lado do handoff: quando há, `performHumanHandoff`
 * grava a marca JUNTO com `last_handoff_reason`, no mesmo UPDATE. Qualquer
 * falha de leitura devolve "sem marca" — que é o caso seguro: o handoff fica
 * exatamente como era antes desta issue.
 */
export async function derivacaoPendenteDoGatilho(
  db: { query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> },
  tenantId: string,
  messageId: string | null | undefined,
): Promise<{ messageId: string } | null> {
  if (!messageId) return null;
  try {
    const { rows } = await db.query(
      `select media_url, media_derived_status
         from messages
        where id = $1 and organization_id = $2 and direction = 'inbound'`,
      [messageId, tenantId],
    );
    const mensagem = rows[0] as MensagemComDerivacao | undefined;
    if (!mensagem || !derivacaoAindaEmAberto(mensagem)) return null;
    return { messageId };
  } catch {
    return null;
  }
}

/**
 * O corpo que `corpoDaMensagem` (get-lead-context.ts) dá a uma mídia sem
 * legenda e sem derivado: só o marcador `[tipo]`. Qualquer outra coisa é
 * palavra do cliente — texto digitado, legenda ou transcrição pronta.
 */
const SO_MARCADOR_DE_MIDIA = /^\[[a-z_]+\]$/;

/**
 * #2210 — o MOTIVO do handoff pode ter sido outro que não a falta de texto?
 *
 * A marca existe para o handoff cuja causa é a mídia ilegível. A ferramenta
 * `request_human_handoff` é a mesma para todos os motivos do modelo — o pedido
 * explícito do lead incluído —, então o estado da derivação do GATILHO não
 * basta: com "quero falar com um atendente" e um áudio no mesmo lote, o
 * gatilho é o áudio pendente e o motivo é o pedido.
 *
 * A regra: só marca quando NADA do que o cliente disse e ainda não foi
 * respondido (`pendentesDoCliente` do turno) era legível — tudo é marcador de
 * mídia. Aí o modelo não tinha palavra do cliente sobre a qual decidir, e a
 * falta de texto é a causa. Lista ausente ou vazia = não sei = sem marca.
 *
 * Limite declarado: um turno só de mídia ilegível em que o modelo passa a
 * conversa por algo do HISTÓRICO sai marcado. A devolução reenfileira o turno,
 * agora com o texto, e o modelo decide de novo.
 */
export function turnoSemPalavraDoCliente(pendentes: readonly string[] | undefined): boolean {
  if (!pendentes || pendentes.length === 0) return false;
  return pendentes.every((texto) => SO_MARCADOR_DE_MIDIA.test(texto.trim()));
}

/** `undefined`/`null`/objeto malformado → nenhuma marca (nunca devolve nada por acidente). */
export function lerMarcaDeHandoffTecnico(metadata: unknown): MarcaDeHandoffTecnico | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const marca = (metadata as Record<string, unknown>)[CHAVE_DO_HANDOFF_TECNICO];
  if (!marca || typeof marca !== "object" || Array.isArray(marca)) return null;
  const campos = marca as Record<string, unknown>;
  if (typeof campos.message_id !== "string" || typeof campos.motivo_gravado !== "string") return null;
  if (typeof campos.marcado_em !== "string") return null;
  if (typeof campos.resolvido_em === "string") return null;
  return {
    causa: "derivacao_ausente",
    message_id: campos.message_id,
    motivo_gravado: campos.motivo_gravado,
    marcado_em: campos.marcado_em,
  };
}

export interface ConversaEmHandoff {
  status: string | null;
  bot_silenced_until: string | null;
  last_handoff_reason: string | null;
  assigned_to_user_id: string | null;
  assignee_kind: string | null;
  metadata: unknown;
}

export type ReacaoAposDerivacao =
  | { acao: "nada"; porque: string }
  /** Devolve pela MESMA função do botão e reenfileira o turno — #2210 ponto 2. */
  | { acao: "devolver" }
  /** Humano já assumiu ou já respondeu (ou a devolução não saiu): o motivo tem de parar de mentir. */
  | {
      acao: "corrigir_motivo";
      motivo: string;
      porque: "humano_assumiu" | "humano_respondeu" | "devolucao_falhou";
    };

/**
 * O motivo que substitui o falso. É afirmativo: diz o que ACONTECEU, não o que
 * faltava — `last_handoff_reason` é o texto que a tela mostra a quem abre a
 * conversa, e ele não pode seguir afirmando algo que `messages` já desmentiu.
 */
export function motivoResolvido(quando: Date): string {
  return (
    "a transcrição do áudio que faltava chegou em " +
    quando.toISOString() +
    " — o motivo do handoff (sem transcrição de texto disponível) já não vale mais"
  );
}

/**
 * Todo o julgamento é puro e recebe o estado da conversa na mão — é o que
 * permite testar os três casos da issue sem tocar banco.
 */
export function decidirReacaoAposDerivacao(entrada: {
  conversa: ConversaEmHandoff;
  messageId: string;
  agora: Date;
  /**
   * Uma pessoa já RESPONDEU ao lead depois da marca — pelo inbox ou pelo
   * celular. Responder não atribui a conversa (o inbox só estende o silêncio; o
   * celular, com o silêncio já `infinity`, não grava nada), então
   * `assigned_to_user_id` não enxerga esse humano.
   */
  humanoRespondeuDepoisDaMarca?: boolean;
}): ReacaoAposDerivacao {
  const { conversa, messageId, agora } = entrada;
  const marca = lerMarcaDeHandoffTecnico(conversa.metadata);
  if (!marca) return { acao: "nada", porque: "sem_marca" };
  if (marca.message_id !== messageId) return { acao: "nada", porque: "outra_mensagem" };
  if (conversa.last_handoff_reason !== marca.motivo_gravado)
    return { acao: "nada", porque: "motivo_gravado_divergiu" };
  if (conversa.bot_silenced_until !== SILENCIO_FORMAL)
    return { acao: "nada", porque: "sem_handoff_formal" };
  if (conversa.status && !STATUS_QUE_VOLTA_AO_AUTOMATICO.has(conversa.status))
    return { acao: "nada", porque: "conversa_encerrada" };

  // Quem já assumiu fica com a conversa: só o motivo é corrigido.
  if (conversa.assigned_to_user_id || conversa.assignee_kind === "user")
    return { acao: "corrigir_motivo", motivo: motivoResolvido(agora), porque: "humano_assumiu" };

  // Quem já respondeu sem clicar em "Assumir" também está conversando: devolver
  // poria o agente a falar por cima dele, respondendo a um áudio velho.
  if (entrada.humanoRespondeuDepoisDaMarca)
    return { acao: "corrigir_motivo", motivo: motivoResolvido(agora), porque: "humano_respondeu" };

  return { acao: "devolver" };
}

type ConversaLida = ConversaEmHandoff & {
  id: string;
  organization_id: string | null;
  contact_id: string | null;
  channel_session_id: string | null;
};

const ATOR = { type: "webhook_source", id: "worker:media-derive" } as const;

/**
 * Chamada pelo worker DEPOIS de gravar `media_derived_status = 'ready'`.
 *
 * Nunca lança: falhar aqui não pode desfazer uma transcrição que já foi salva.
 * A derivação responde `ok` mesmo que a reação não aconteça.
 */
export async function reagirAConclusaoDeDerivacao(
  admin: SupabaseClient,
  entrada: {
    organizationId: string;
    conversationId: string;
    messageId: string;
    requestId: string;
    agora?: Date;
  },
): Promise<ReacaoAposDerivacao> {
  const { organizationId, conversationId, messageId, requestId } = entrada;
  const agora = entrada.agora ?? new Date();
  try {
    const { data, error } = await admin
      .from("conversations")
      .select(
        "id, organization_id, contact_id, channel_session_id, status, bot_silenced_until, last_handoff_reason, assigned_to_user_id, assignee_kind, metadata",
      )
      .eq("id", conversationId)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (error) {
      logger.warn("handoff-tecnico: nao consegui ler a conversa", { error: error.message });
      return { acao: "nada", porque: "erro_de_leitura" };
    }
    const conversa = data as ConversaLida | null;
    if (!conversa) return { acao: "nada", porque: "conversa_inexistente" };

    const marca = lerMarcaDeHandoffTecnico(conversa.metadata);
    const humanoRespondeuDepoisDaMarca =
      marca !== null && (await humanoRespondeuDepoisDe(admin, organizationId, conversationId, marca.marcado_em));
    const decisao = decidirReacaoAposDerivacao({ conversa, messageId, agora, humanoRespondeuDepoisDaMarca });
    if (decisao.acao === "nada") return decisao;

    if (decisao.acao === "devolver") {
      let devolvido = false;
      try {
        const r = await devolverAtendimentoAoAgente(
          { supabase: admin, organizationId, actor: ATOR, requestId },
          { conversationId },
        );
        devolvido = r.ok;
      } catch (erro) {
        logger.warn("handoff-tecnico: devolucao lancou", {
          conversationId,
          erro: erro instanceof Error ? erro.message : String(erro),
        });
      }
      if (devolvido) {
        await gravarResolucao(admin, conversa, marca, agora, true);
        await reenfileirarTurno(admin, { organizationId, conversation: conversa, messageId, requestId });
        return { acao: "devolver" };
      }
      // A devolução não saiu (conflito de atribuição, senha/booking, trava): o
      // handoff fica, mas o motivo não pode continuar mentindo.
      const motivo = motivoResolvido(agora);
      await corrigirMotivo(admin, conversationId, organizationId, motivo);
      await gravarResolucao(admin, conversa, marca, agora, false);
      return { acao: "corrigir_motivo", motivo, porque: "devolucao_falhou" };
    }

    await corrigirMotivo(admin, conversationId, organizationId, decisao.motivo);
    await gravarResolucao(admin, conversa, marca, agora, false);
    return decisao;
  } catch (erro) {
    logger.warn("handoff-tecnico: reacao nao aconteceu", {
      conversationId,
      messageId,
      erro: erro instanceof Error ? erro.message : String(erro),
    });
    return { acao: "nada", porque: "erro" };
  }
}

/**
 * Saiu mensagem de GENTE para o lead depois da marca? `sent_via` `user` é o
 * inbox; `external_device` é o celular — o mesmo sinal humano que a cron de
 * devolução já conta (`lib/escalacao/devolucao-automatica.ts`). O aviso do
 * handoff ao lead sai com `ai` e não conta.
 *
 * A comparação é no relógio do BANCO dos dois lados: `marcado_em` é o `now()`
 * do UPDATE do handoff, `created_at` é o default da linha. Comparar com o
 * relógio do Node deixaria uma resposta colada na marca escapar por desvio.
 *
 * Erro de leitura conta como "respondeu": falhar fechado na ação — no pior
 * caso o motivo é corrigido e a conversa fica com o humano, como estava.
 */
async function humanoRespondeuDepoisDe(
  admin: SupabaseClient,
  organizationId: string,
  conversationId: string,
  marcadoEm: string,
): Promise<boolean> {
  const { data, error } = await admin
    .from("messages")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("conversation_id", conversationId)
    .eq("direction", "outbound")
    .in("sent_via", ["user", "external_device"])
    .gt("created_at", marcadoEm)
    .limit(1);
  if (error) {
    logger.warn("handoff-tecnico: nao consegui saber se um humano respondeu", { error: error.message });
    return true;
  }
  return (data ?? []).length > 0;
}

async function corrigirMotivo(
  admin: SupabaseClient,
  conversationId: string,
  organizationId: string,
  motivo: string,
): Promise<void> {
  const { error } = await admin
    .from("conversations")
    .update({ last_handoff_reason: motivo })
    .eq("id", conversationId)
    .eq("organization_id", organizationId);
  if (error) logger.warn("handoff-tecnico: motivo nao corrigido", { error: error.message });
}

/** `resolvido_em` marca que a reação já rodou — uma segunda derivação não repete. */
async function gravarResolucao(
  admin: SupabaseClient,
  conversa: ConversaLida,
  marca: MarcaDeHandoffTecnico | null,
  quando: Date,
  devolvido: boolean,
): Promise<void> {
  if (!marca) return;
  const metadata = {
    ...((conversa.metadata && typeof conversa.metadata === "object"
      ? conversa.metadata
      : {}) as Record<string, unknown>),
    [CHAVE_DO_HANDOFF_TECNICO]: {
      ...marca,
      resolvido_em: quando.toISOString(),
      ...(devolvido ? { devolvido: true } : {}),
    },
  };
  const { error } = await admin
    .from("conversations")
    .update({ metadata })
    .eq("id", conversa.id)
    .eq("organization_id", conversa.organization_id ?? "");
  if (error) logger.warn("handoff-tecnico: marca nao resolvida", { error: error.message });
}

/**
 * Enfileira o turno que não aconteceu.
 *
 * Mesmo evento de um texto normal (`ai_agent.dispatch_requested`), então passa
 * pelo drain — que é quem segura na porta: elegibilidade, grupo, debounce,
 * anti-backlog (se um texto mais novo já estiver na fila, este turno é
 * dispensado) e idempotência por `source_event_id`.
 */
async function reenfileirarTurno(
  admin: SupabaseClient,
  entrada: {
    organizationId: string;
    conversation: ConversaLida;
    messageId: string;
    requestId: string;
  },
): Promise<void> {
  const { organizationId, conversation, messageId, requestId } = entrada;
  const { error } = await admin.rpc("emit_event", {
    p_event_type: "ai_agent.dispatch_requested",
    p_entity_kind: "message",
    p_entity_id: messageId,
    p_payload: {
      organization_id: organizationId,
      conversation_id: conversation.id,
      contact_id: conversation.contact_id,
      channel_session_id: conversation.channel_session_id,
      inbound_message_id: messageId,
    },
    p_metadata: { source: "media-derive-worker", request_id: requestId, motivo: "derivacao_concluiu_apos_handoff" },
    p_organization_id: organizationId,
  });
  if (error) logger.warn("handoff-tecnico: turno nao reenfileirado", { error: error.message });
}
