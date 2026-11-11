/**
 * AVISO DE STATUS DO MODELO no canal OFICIAL DIRETO (fatia 3 do #3635).
 *
 * ─── O que estava invisível ────────────────────────────────────────────────
 *
 * Quando a Meta aprova, reprova ou pausa um modelo, o CRM atualiza o espelho em
 * `meta_templates` e cala. Quem usa o canal de parceiro já recebe aviso na
 * Central (`lib/channels/zernio/avisos.ts`); quem conecta direto pela Cloud API
 * descobria a reprovação no disparo que não saiu — com a campanha montada e o
 * cliente esperando.
 *
 * ─── Por que o mesmo caminho, e não uma segunda Central ────────────────────
 *
 * O aviso é a MESMA linha de `agent_inbox_items` que o canal de parceiro usa:
 * mesma tabela, mesmo lugar na tela, mesma régua de severidade. O que muda é o
 * `kind` — e ele precisa ser próprio, por duas razões medidas:
 *
 *   - o destino do aviso de parceiro aponta para `aba=parceiro`; mandar quem
 *     tem canal oficial para a aba do parceiro é um aviso que leva ao lugar
 *     errado, que é pior que não linkar;
 *   - o dedup de lá é por (kind, título, aberto). Com um kind só para os dois
 *     canais, um modelo homônimo reprovado nas DUAS conexões da mesma empresa
 *     viraria um aviso só, e o operador consertaria o modelo errado.
 *
 * Por isso o aviso daqui nasce com `ref_kind='channel_session'` + `ref_id` da
 * conexão: o escopo é a conexão, não a organização.
 *
 * ─── Texto cru da Meta não chega ao operador ───────────────────────────────
 *
 * `rejected_reason` vem como código (`PROMOTIONAL`, `INVALID_FORMAT`…) ou como
 * frase em inglês, e o vocabulário dela é aberto. Isto traduz o que conhecemos
 * e, para o resto, diz que não veio detalhe — nunca repassa o cru: "PROMOTIONAL"
 * na Central não ensina ninguém a corrigir o texto, e frase em inglês no meio de
 * uma tela em português parece defeito nosso.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

/**
 * O kind deste aviso. Existe separado de `channel_template_review` (o do canal
 * de parceiro) pelo destino e pelo rótulo — ver o cabeçalho.
 */
export const KIND_DO_AVISO_DO_MODELO = "channel_template_review_direct";

export type SeveridadeDoAviso = "info" | "warn" | "critical";

/** O pedaço do evento `template_status` que o aviso consome. */
export interface StatusDoModelo {
  templateName: string;
  templateLanguage: string;
  /** O que a Meta chamou o desfecho: `APPROVED`, `REJECTED`, `PAUSED`… */
  event: string;
  reason: string | null;
}

export interface AvisoDoModelo {
  kind: typeof KIND_DO_AVISO_DO_MODELO;
  severity: SeveridadeDoAviso;
  title: string;
  body: string;
}

interface Desfecho {
  /** Como o operador lê o desfecho. Verbo no particípio: "aprovado". */
  rotulo: string;
  severity: SeveridadeDoAviso;
  /** O que muda para quem trabalha. Nunca repete o rótulo. */
  frase: string;
}

/**
 * Os desfechos que a revisão da Meta produz.
 *
 * `critical` fica para o que INTERROMPE o envio (reprovado, desativado): a
 * campanha que dependia do modelo não sai. `warn` para o que pede atenção sem
 * parar nada (pausado por qualidade, em recurso). `info` para boa notícia e
 * para o que ainda vai acontecer — marcar tudo de vermelho é o mesmo que não
 * marcar nada.
 */
const DESFECHOS: Record<string, Desfecho> = {
  APPROVED: {
    rotulo: "aprovado",
    severity: "info",
    frase: "A Meta aprovou o modelo: ele já pode ser escolhido nos disparos.",
  },
  REJECTED: {
    rotulo: "rejeitado",
    severity: "critical",
    frase:
      "A Meta rejeitou o modelo e ele NÃO pode ser enviado. Corrija o texto e envie de novo para revisão.",
  },
  PAUSED: {
    rotulo: "pausado",
    severity: "warn",
    frase:
      "A Meta pausou o modelo por qualidade das mensagens enviadas. Ele volta sozinho se a qualidade melhorar; até lá, não conta com ele.",
  },
  DISABLED: {
    rotulo: "desativado",
    severity: "critical",
    frase: "A Meta desativou o modelo: ele não pode mais ser enviado.",
  },
  PENDING: {
    rotulo: "em análise",
    severity: "info",
    frase: "O modelo entrou na fila de revisão da Meta. Nada a fazer por enquanto.",
  },
  IN_APPEAL: {
    rotulo: "em recurso",
    severity: "warn",
    frase: "O modelo está em recurso na Meta. Ele só volta a valer quando a revisão terminar.",
  },
  PENDING_DELETION: {
    rotulo: "aguardando exclusão",
    severity: "warn",
    frase: "A Meta está excluindo o modelo: ele sai do ar em breve.",
  },
};

/**
 * Motivo da recusa em português, a partir do que a Meta manda.
 *
 * O vocabulário dela é aberto e muda sem aviso; o que não está aqui vira texto
 * genérico, e é o comportamento certo: inventar tradução para um código
 * desconhecido seria adivinhar o problema do cliente.
 */
const MOTIVOS: Record<string, string> = {
  ABUSIVE_CONTENT: "O texto foi considerado abusivo pela Meta.",
  INVALID_FORMAT:
    "O formato não segue o que a Meta aceita — confira variáveis, exemplos, cabeçalho e botões.",
  INVALID_MEDIA: "A imagem ou o arquivo do cabeçalho não foi aceito.",
  INVALID_PARAMETER: "Um dos campos do modelo está inválido.",
  INVALID_PARAMETERS: "Um dos campos do modelo está inválido.",
  PROMOTIONAL:
    "O texto parece promoção, e a categoria escolhida não permite conteúdo promocional.",
  TAG_MISMATCH: "A categoria escolhida não combina com o conteúdo do texto.",
  INCORRECT_CATEGORY: "A categoria do modelo não corresponde ao conteúdo do texto.",
  SCAM: "O texto foi classificado como golpe pela Meta.",
};

const STR = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/** Motivo legível; `null` quando a Meta não mandou detalhe ou mandou um que não traduzimos. */
export function motivoLegivel(reason: string | null): string | null {
  const cru = STR(reason);
  if (!cru) return null;
  // `NONE` é como a Meta diz "sem motivo" — repassá-lo seria ruído no lugar onde
  // o operador procura a explicação.
  if (cru.toUpperCase() === "NONE") return null;
  return MOTIVOS[cru.trim().toUpperCase()] ?? null;
}

/**
 * O aviso deste evento — ou `null` quando não há o que avisar.
 *
 * `null` cobre DOIS casos que a rota não distingue hoje, e os dois são
 * intencionais: evento que não conhecemos (a Meta amplia o vocabulário sem
 * avisar; tratar como erro faria re-entrega em loop) e estado que não muda nada
 * para quem opera.
 */
export function avisoDoStatusDoModelo(status: StatusDoModelo): AvisoDoModelo | null {
  const desfecho = DESFECHOS[status.event?.toUpperCase() ?? ""];
  if (!desfecho) return null;

  const nome = STR(status.templateName);
  const idioma = STR(status.templateLanguage);
  if (!nome || !idioma) return null;

  const motivo = status.event.toUpperCase() === "REJECTED" ? motivoLegivel(status.reason) : null;
  const corpo = [
    desfecho.frase,
    motivo ?? (status.event.toUpperCase() === "REJECTED" ? "A Meta não detalhou o motivo." : null),
    `Modelo "${nome}", idioma ${idioma}. Confira em Conexões › Modelos.`,
  ]
    .filter((linha): linha is string => !!linha)
    .join(" ");

  return {
    kind: KIND_DO_AVISO_DO_MODELO,
    severity: desfecho.severity,
    // Título curto com o que identifica o assunto na lista: nome + idioma +
    // desfecho. É ele que o dedup usa, então precisa conter o EVENTO — um
    // aprovado depois de um reprovado é notícia nova, não repetição.
    title: `Modelo "${nome}" (${idioma}): ${desfecho.rotulo}`,
    body: corpo,
  };
}

export type DesfechoDoAviso = "aviso" | "aviso_repetido" | "sem_aviso" | "aviso_falhou";

/**
 * Como o aviso aparece em `outcomes` da resposta do webhook.
 *
 * O desfecho do EVENTO continua sendo `modelo` (o espelho foi atualizado) e o
 * do aviso entra como sufixo. Achatar os dois num rótulo só apagaria a
 * distinção que esta mudança existe para criar: "espelho atualizado, aviso não"
 * é justamente o caso que precisa aparecer quando alguém for depurar.
 */
export function desfechoDoAviso(desfecho: DesfechoDoAviso): string {
  return desfecho === "sem_aviso" ? "modelo" : `modelo:${desfecho}`;
}

export interface AlvoDoAviso {
  organizationId: string;
  /** A conexão do canal — o aviso não vaza para outra conexão da mesma empresa. */
  channelSessionId: string;
}

/**
 * Grava o aviso na Central. NUNCA lança.
 *
 * ─── Por que engolir a falha é o certo aqui ────────────────────────────────
 *
 * Quem chama é o webhook. Um throw viraria 5xx, e a Meta re-entrega tudo que não
 * recebe 2xx — em backoff por horas. O evento é o MESMO para sempre, então a
 * falha não se conserta com re-entrega: vira auto-DDoS contra a nossa própria
 * rota. O espelho do modelo já foi atualizado antes desta chamada, que é a
 * informação que a tela usa; perder o empurrão é ruim, perder a rota é pior.
 *
 * A falha também não fica muda: vai para o log estruturado com org e conexão.
 */
export async function avisarStatusDoModelo(
  admin: SupabaseClient,
  alvo: AlvoDoAviso,
  status: StatusDoModelo,
): Promise<DesfechoDoAviso> {
  const aviso = avisoDoStatusDoModelo(status);
  if (!aviso) return "sem_aviso";

  try {
    // `ref_kind`+`ref_id` são o escopo: o dedup do canal de parceiro é por
    // título, e título igual em duas conexões da mesma empresa é o caso normal
    // (o mesmo nome de modelo criado nos dois números).
    const { data: jaAberto, error: erroDaConsulta } = await admin
      .from("agent_inbox_items")
      .select("id")
      .eq("organization_id", alvo.organizationId)
      .eq("kind", aviso.kind)
      .eq("ref_kind", "channel_session")
      .eq("ref_id", alvo.channelSessionId)
      .eq("title", aviso.title)
      .eq("status", "open")
      .limit(1)
      .maybeSingle();

    if (erroDaConsulta) {
      // Consulta que falha não é "já existe": seguir para o insert é escolher
      // aviso repetido em vez de aviso nenhum — a Central ruidosa se conserta
      // fechando um item; o aviso que não existe, ninguém sabe que faltou.
      logger.error("[aviso-do-modelo] dedup não consultado", {
        organization_id: alvo.organizationId,
        channel_session_id: alvo.channelSessionId,
        erro: erroDaConsulta.message,
      });
    }
    if (jaAberto) return "aviso_repetido";

    const { error } = await admin.from("agent_inbox_items").insert({
      organization_id: alvo.organizationId,
      kind: aviso.kind,
      severity: aviso.severity,
      title: aviso.title,
      body: aviso.body,
      ref_kind: "channel_session",
      ref_id: alvo.channelSessionId,
    });

    if (error) {
      logger.error("[aviso-do-modelo] aviso não gravado", {
        organization_id: alvo.organizationId,
        channel_session_id: alvo.channelSessionId,
        model: status.templateName,
        event: status.event,
        erro: error.message,
      });
      return "aviso_falhou";
    }

    return "aviso";
  } catch (erro) {
    logger.error("[aviso-do-modelo] aviso não gravado", {
      organization_id: alvo.organizationId,
      channel_session_id: alvo.channelSessionId,
      model: status.templateName,
      event: status.event,
      erro: erro instanceof Error ? erro.message : String(erro),
    });
    return "aviso_falhou";
  }
}
