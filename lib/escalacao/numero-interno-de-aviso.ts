/**
 * O NÚMERO DE AVISOS É INTERNO — NÃO VIRA CONVERSA DE CLIENTE.
 *
 * ## O que acontece sem este corte
 *
 * Uma mensagem solta da equipe não pode virar conversa de cliente. Respostas
 * explícitas `RESPONDER`/`PERGUNTAR` ao caso são tratadas antes deste corte, no
 * módulo `resposta-whatsapp-ao-caso.ts`. O resto, se passasse, poderia virar:
 *
 *   · um CONTATO com o número do plantão e uma CONVERSA — e é o INSERT da
 *     conversa que dispara o pedido de rodízio pelo banco, então um atendente
 *     recebe a "conversa" do próprio suporte;
 *   · uma linha em `messages` com o texto do aviso dentro da conversa de outra
 *     pessoa, se o chat já existir;
 *   · opt-out: um "cancelar" digitado ali BLOQUEIA o "contato", que é a equipe;
 *   · uma demanda, um card no funil, uma campanha casada;
 *   · um despacho do agente — a IA passa a conversar com o suporte.
 *
 * É por isso que o corte vem **antes de `upsertContact`**: cortar só depois, em
 * `pos-entrada`, já teria criado contato, conversa e pedido de roteamento.
 *
 * ## ⚠️ A LEITURA IGNORA `ligado`
 *
 * Número configurado é interno mesmo com o aviso PAUSADO. Ligar a leitura ao
 * `ligado` faria pausar o aviso numa sexta transformar o número do suporte em
 * lead na segunda — e ninguém ligaria uma coisa à outra.
 *
 * ## Falha de leitura NÃO vira "é interno"
 *
 * Falhar fechado aqui significaria DESCARTAR mensagem de cliente toda vez que o
 * banco engasgasse. A mensagem que passa indevidamente vira um contato a mais,
 * que alguém apaga; a mensagem descartada some para sempre.
 *
 * ## O rastro
 *
 * `logger.info`, **sem telefone e sem corpo** — e isto é CONTRATO, não estilo. A
 * tentação de acrescentar o número "para depurar" é o defeito conhecido: o log
 * de diagnóstico vira depósito de dado pessoal, num arquivo que ninguém
 * expurga. O que identifica a linha é a organização e a direção; o QUE foi
 * ignorado está, em contagem, na configuração — e é a tela que mostra quantas
 * mensagens fora do formato de resposta de caso foram ignoradas.
 *
 * **Não** `emit_event`: evento sem consumidor é o anti-pattern nº 3 do
 * CLAUDE.md, e o descarte aqui é decisão de PRODUTO — a mesma natureza do
 * descarte de grupo, que é silencioso de propósito.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { phoneLookupVariants } from "@/lib/channels/phone-variants";
import { logger } from "@/lib/logger";

/**
 * A identidade que o ingestor já resolveu do chat.
 *
 * Estrutural e não importada do ingestor de propósito: os três ingestores
 * chegam aqui com formatos próprios, e amarrar este módulo ao tipo de um deles
 * faria os outros dois precisarem converter — ou, pior, pularem o corte.
 */
export interface ChatIdentidade {
  /** `phone` | `lid` | `group` | `unknown`, na nomenclatura do ingestor. */
  kind: string;
  /** E.164 com `+`, quando o chat traz telefone. */
  phone: string | null;
  /** O identificador opaco do destinatário em modo privacidade, só dígitos. */
  lid: string | null;
}

/** A configuração, reduzida ao que o corte precisa. */
export interface NumeroInternoDeAviso {
  /** `config_aviso_de_caso.telefone_destino`, E.164. */
  destino: string | null;
  /** `config_aviso_de_caso.destino_jid` — o endereço que o transporte resolveu. */
  jid: string | null;
  respostaWhatsappHabilitada?: boolean;
  /** `config_aviso_de_caso.channel_session_id` — a conexão que envia os avisos. */
  sessaoId?: string | null;
}

/**
 * 30 s — o mesmo horizonte do memo da marca.
 *
 * Isto roda em TODO webhook de mensagem: sem cache, o corte custa uma ida ao
 * banco por mensagem recebida na instalação inteira. Trinta segundos é curto o
 * bastante para trocar o número e ver valer quase na hora, e longo o bastante
 * para uma rajada de mensagens não virar uma rajada de consultas.
 */
export const TTL_DO_CACHE_MS = 30_000;

const _cache = new Map<string, { at: number; valor: NumeroInternoDeAviso }>();

/** Esvazia o memo. Usado pelos testes e por quem grava a configuração. */
export function limparCacheDoNumeroInterno(): void {
  _cache.clear();
}

/**
 * A REGRA, pura e testável: este chat é o número interno de avisos?
 *
 * `phoneLookupVariants` e não comparação de string: o suporte cadastrado com o
 * nono dígito e registrado sem (ou o contrário) é a mesma pessoa, e comparar
 * cru deixaria o corte passar batido justamente no cadastro mais comum.
 */
export function ehOChatDoAviso(parsed: ChatIdentidade, cfg: NumeroInternoDeAviso): boolean {
  if (!cfg.destino && !cfg.jid) return false;

  // Em modo privacidade (`@lid`) o ingestor do canal preenche `phone` com o
  // `_data.key.remoteJidAlt` do payload — e é por ele que o número cadastrado
  // é reconhecido, porque o transporte resolve o destino por telefone
  // (`<tel>@c.us`) e o `destino_jid` nunca termina em `@lid`.
  if ((parsed.kind === "phone" || parsed.kind === "lid") && parsed.phone && cfg.destino &&
      phoneLookupVariants(cfg.destino).includes(parsed.phone)) {
    return true;
  }

  // Sem o telefone alternativo, o `@lid` só casa pelo JID, que só é conhecido
  // depois de um aviso enviado a esse endereço — esse buraco está declarado no
  // teste.
  if (parsed.kind === "lid" && parsed.lid && cfg.jid) {
    return cfg.jid === `${parsed.lid}@lid`;
  }

  return false;
}

/** A configuração da organização, memoizada por 30 s. Nunca lança. */
export async function lerNumeroInternoDeAviso(
  db: SupabaseClient,
  organizationId: string,
): Promise<NumeroInternoDeAviso> {
  const agora = Date.now();
  const emCache = _cache.get(organizationId);
  if (emCache && agora - emCache.at < TTL_DO_CACHE_MS) return emCache.valor;

  // ⚠️ `ligado` NÃO entra no `select` nem no `where` — ver o cabeçalho.
  //
  // ⚠️ O `try` cobre a CHAMADA, não só o `error` do PostgREST — e a diferença
  // não é zelo: este código roda dentro do webhook de mensagem, e uma exceção
  // aqui derrubaria a ingestão INTEIRA de um cliente por causa de uma leitura
  // acessória. Um clone com a imagem nova e o schema velho não tem a tabela e
  // recebe `42P01`; um client sem rede lança antes de devolver `error`.
  let data: unknown = null;
  try {
    const r = await db
      .from("config_aviso_de_caso")
      .select("telefone_destino, destino_jid, resposta_whatsapp_habilitada, channel_session_id")
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (r.error) throw new Error(r.error.message);
    data = r.data;
  } catch (err) {
    // ABERTA na ação (a mensagem segue o caminho normal) e NOMEADA no log: uma
    // leitura que falha não pode descartar mensagem de cliente, mas também não
    // pode sumir. Sem cachear: a próxima mensagem tenta de novo.
    logger.warn("[aviso-interno] não foi possível ler o número interno de avisos", {
      organizationId,
      causa: err instanceof Error ? err.message : String(err),
    });
    return { destino: null, jid: null, respostaWhatsappHabilitada: false, sessaoId: null };
  }

  const linha = data as {
    telefone_destino?: string | null;
    destino_jid?: string | null;
    resposta_whatsapp_habilitada?: boolean | null;
    channel_session_id?: string | null;
  } | null;
  const valor: NumeroInternoDeAviso = {
    destino: linha?.telefone_destino ?? null,
    jid: linha?.destino_jid ?? null,
    respostaWhatsappHabilitada: linha?.resposta_whatsapp_habilitada === true,
    sessaoId: linha?.channel_session_id ?? null,
  };
  _cache.set(organizationId, { at: agora, valor });
  return valor;
}

/**
 * O CINTO DE SEGURANÇA, pela FICHA do contato — nunca a defesa principal.
 *
 * Os ingestores cortam ANTES de `upsertContact`, que é o que importa: é o
 * INSERT da conversa que dispara o rodízio pelo banco. Este aqui roda depois,
 * em `aplicarEfeitosPosEntrada`, e existe para o caminho que alguém venha a
 * esquecer — um ingestor novo, um provedor novo, uma reentrega por outro
 * caminho. Ele impede opt-out, demanda, campanha e despacho do agente; NÃO
 * impede o contato e a conversa, que a essa altura já nasceram.
 *
 * A ordem das duas leituras é o que o torna barato: a configuração vem do memo
 * de 30 s e, quando não há número interno configurado — o caso de toda
 * instalação que nunca ligou o aviso —, a função sai sem tocar o banco.
 */
export async function ehContatoDoNumeroInterno(
  db: SupabaseClient,
  organizationId: string,
  contactId: string,
): Promise<boolean> {
  const cfg = await lerNumeroInternoDeAviso(db, organizationId);
  if (!cfg.destino && !cfg.jid) return false;

  // Mesmo `try` da leitura acima, e pela mesma razão: o CINTO não pode ser o
  // que derruba a cadeia de efeitos que ele existe para proteger.
  let data: unknown = null;
  try {
    const r = await db
      .from("contacts")
      .select("phone_number, wa_lid")
      .eq("organization_id", organizationId)
      .eq("id", contactId)
      .maybeSingle();
    if (r.error) throw new Error(r.error.message);
    data = r.data;
  } catch (err) {
    logger.warn("[aviso-interno] cinto de segurança não pôde ler o contato", {
      organizationId,
      causa: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
  if (!data) return false;

  const linha = data as { phone_number?: string | null; wa_lid?: string | null };
  return ehOChatDoAviso(
    {
      kind: linha.phone_number ? "phone" : "lid",
      phone: linha.phone_number ?? null,
      lid: linha.wa_lid ?? null,
    },
    cfg,
  );
}

/** A pergunta que os ingestores fazem, com a leitura já resolvida. */
export async function ehNumeroInternoDeAviso(
  db: SupabaseClient,
  organizationId: string,
  parsed: ChatIdentidade,
): Promise<boolean> {
  // Atalho barato: grupo e formato desconhecido nunca são o número de aviso, e
  // perguntar ao banco por eles gastaria a consulta quente à toa.
  if (parsed.kind !== "phone" && parsed.kind !== "lid") return false;
  return ehOChatDoAviso(parsed, await lerNumeroInternoDeAviso(db, organizationId));
}

/**
 * O rastro do descarte: uma linha de log e o contador da configuração.
 *
 * ⚠️ CONTRATO: nada aqui leva TELEFONE nem CORPO. `organizationId`, a direção e
 * o canal respondem "onde e por onde"; o QUE foi ignorado não é assunto de log —
 * ele é a mensagem de uma pessoa da equipe.
 *
 * O contador existe porque o silêncio, na tela, é indistinguível de defeito: sem
 * ele, "as mensagens que eu mando para esse número somem" parece bug. Com ele, a
 * tela de configuração diz quantas foram ignoradas e desde quando — e afirma que
 * é o esperado.
 *
 * Fire-and-forget de verdade: o contador NUNCA pode segurar nem derrubar a
 * ingestão. Falha dele vira log e o webhook segue.
 */
export async function registrarMensagemIgnorada(
  db: SupabaseClient,
  organizationId: string,
  contexto: { direction: "inbound" | "outbound"; sessionId: string | null },
): Promise<void> {
  logger.info("[ingest] mensagem do número interno de avisos ignorada", {
    organizationId,
    direction: contexto.direction,
    sessionId: contexto.sessionId,
  });
  try {
    const { error } = await db.rpc("fn_contar_mensagem_ignorada" as never, {
      p_org: organizationId,
    } as never);
    if (error) {
      logger.warn("[aviso-interno] contador de mensagens ignoradas não avançou", {
        organizationId,
        causa: error.message,
      });
    }
  } catch (err) {
    logger.warn("[aviso-interno] contador de mensagens ignoradas não avançou", {
      organizationId,
      causa: err instanceof Error ? err.message : String(err),
    });
  }
}
