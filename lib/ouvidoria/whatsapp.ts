/**
 * OUVIDORIA — O CANAL DO WHATSAPP (#3611, fatia 2).
 *
 * ─── O defeito que esta camada fecha ────────────────────────────────────────
 *
 * A fatia 1 entregou o REGISTRO (`lib/ouvidoria/registro.ts`): uma linha em
 * `ouvidoria_manifestacoes`, com protocolo do servidor, sem card no funil. Só
 * que ninguém chega até ele — a pessoa que reclama pelo WhatsApp cai na
 * ingestão de sempre (`lib/channels/pos-entrada.ts`), que abre demanda no funil
 * e acorda o agente. Ou seja: a manifestação volta a ser oportunidade de venda,
 * que é exatamente o que a #3611 pede para não acontecer.
 *
 * ─── O que esta fatia entrega, e o que NÃO entrega ──────────────────────────
 *
 * Entrega o FLUXO da conversa: reconhece o pedido, junta o relato (que chega em
 * várias mensagens, como no WhatsApp de verdade), apresenta um resumo, pede
 * confirmação e — **só depois que a gravação deu certo** — devolve o protocolo.
 * E entrega o DESVIO: mensagem de uma conversa da Ouvidoria não cria negócio
 * nenhum no funil e não acorda o agente.
 *
 * Fica FORA, declarado no PR: anexos e e-mail de notificação (fatia 3), a tela
 * de gestão e os perfis autorizados (fatia 1 já reservou a leitura restrita), e
 * os canais Instagram/Facebook — o fluxo é do WhatsApp, e o desvio só vale para
 * `conversations.channel = 'whatsapp'`.
 *
 * ─── As três garantias que este arquivo existe para provar ──────────────────
 *
 * 1. **A confirmação NUNCA precede a gravação.** É a frase literal da issue
 *    ("confirmar o registro somente após a gravação bem-sucedida"). Se o insert
 *    falha, a pessoa recebe "não conseguimos registrar, nada foi gravado" e o
 *    rascunho continua de pé para a tentativa seguinte. Confirmar antes de
 *    gravar é o pior desfecho possível do módulo inteiro: a pessoa anota um
 *    protocolo que não existe em lugar nenhum, e a ouvidoria nunca fica sabendo
 *    da reclamação.
 *
 * 2. **A conversa da Ouvidoria não toca no funil.** Quem chama (a ingestão)
 *    recebe `tratado: true` e para ali: sem `garantirLeadDaConversa`, sem
 *    campanha, sem follow-up, sem despacho do agente. O rastro de que isso
 *    aconteceu é um log, não um card.
 *
 * 3. **Desligado não muda nada.** Só o `true` explícito de
 *    `settings.ouvidoria.ativa` (a régua de `ouvidoriaLigada`, da fatia 1) abre
 *    o fluxo. Ausente/lixo = `tratado: false`, e a mensagem segue o caminho de
 *    hoje — que é o controle de que esta fatia não sequestrou a ingestão.
 *
 * ─── Por que o estado mora em `conversations.metadata` ─────────────────────
 *
 * O rascunho (relato em construção, resumo, se já está confirmando) é estado de
 * CONVERSA, não fato de negócio: não vale migration, e a linha da conversa já
 * existe em toda mensagem que entra. Fica na chave `ouvidoria` do `metadata`,
 * com leitura e escrita por read-modify-write (as outras chaves são preservadas
 * — `metadata` é compartilhado com o Inbox). O rascunho EXPIRA em 24 h: um
 * relato abandonado não pode sequestrar a conversa para sempre — quem volta
 * depois de dois dias começa de novo, e o que já foi registrado continua na
 * tabela da fatia 1.
 *
 * ─── Multi-tenant sem sessão ────────────────────────────────────────────────
 *
 * Como no registro, este caminho roda com cliente de SERVIÇO: toda leitura e
 * toda escrita carrega `.eq("organization_id", …)`, e a organização vem do
 * canal que recebeu a mensagem — nunca do texto dela. O `organization_id` da
 * manifestação é o mesmo desta função; o contato é conferido pelo registro.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import {
  registrarManifestacao,
  TEXTO_MAXIMO,
  type ManifestacaoRegistrada,
  type ResultadoDoRegistro,
} from "@/lib/ouvidoria/registro";
import { ouvidoriaLigada } from "@/lib/schemas/settings";

/** A chave do rascunho dentro de `conversations.metadata`. */
export const CHAVE_NO_METADATA = "ouvidoria";

/**
 * A marca das mensagens que ESTE módulo enviou.
 *
 * Vai em `messages.metadata` para que a conversa diga, meses depois, quem
 * escreveu aquilo: não foi uma pessoa nem a IA — foi a Ouvidoria.
 */
export const MARCA_DA_RESPOSTA = "ouvidoria";

/**
 * Quanto tempo um rascunho abandonado ainda vale.
 *
 * 24 h é o mesmo horizonte da janela de conversa do WhatsApp: passado isso o
 * número nem pode responder de graça, e um relato retomado no dia seguinte
 * contra um resumo de dois dias atrás é uma confirmação sobre texto que a
 * pessoa não lembra de ter escrito.
 */
export const VALIDADE_DO_RASCUNHO_MS = 24 * 60 * 60 * 1000;

/** Quantos caracteres do relato o resumo mostra antes de cortar. */
export const TETO_DO_RESUMO = 600;

/** Os dois estados do rascunho — não há terceiro: ou se coleta, ou se confirma. */
export const ESTADOS_DO_RASCUNHO = ["coletando", "confirmando"] as const;

export type EstadoDoRascunho = (typeof ESTADOS_DO_RASCUNHO)[number];

export interface RascunhoDaOuvidoria {
  estado: EstadoDoRascunho;
  /** Os pedaços do relato, na ordem em que chegaram (uma mensagem = um pedaço). */
  partes: string[];
  /** O resumo apresentado; só existe em `confirmando`. */
  resumo: string | null;
  /** ISO do último toque — é o relógio da validade. */
  atualizadoEm: string;
  /** A última mensagem já contabilizada; é a guarda de reentrega. */
  ultimaMensagemId: string | null;
}

// ---------------------------------------------------------------------------
// Texto: o que a Ouvidoria diz
// ---------------------------------------------------------------------------

/**
 * As frases do fluxo, escritas UMA vez.
 *
 * Elas não são configuráveis de propósito: o texto da confirmação carrega a
 * garantia central do módulo ("só depois da gravação"), e uma frase editável
 * pela tela poderia prometer protocolo antes de existir um. Idiomas ficam para
 * quando houver tela.
 */
export function textoInicial(): string {
  return (
    "Ouvidoria: recebemos sua mensagem. Pode escrever o relato em quantas " +
    "mensagens precisar — quando terminar, responda PRONTO."
  );
}

export function textoDoResumo(resumo: string, mensagens: number): string {
  const origem = mensagens > 1 ? ` (${mensagens} mensagens)` : "";
  return (
    `Resumo do seu relato${origem}:\n\n${resumo}\n\n` +
    "Responda CONFIRMAR para registrar ou CANCELAR para descartar."
  );
}

/** A ÚNICA frase que pode carregar protocolo — e só com a linha já gravada. */
export function textoDaConfirmacao(protocolo: string): string {
  return (
    `Manifestação registrada. Protocolo ${protocolo}. ` +
    "Guarde este número para acompanhar o andamento."
  );
}

/**
 * A frase da falha. Sem protocolo, sem "registrado", e dizendo o que de fato
 * aconteceu: NADA foi gravado. É o que impede a pessoa de anotar um número que
 * não existe.
 */
export function textoDaFalha(): string {
  return (
    "Não conseguimos registrar sua manifestação agora e nada foi gravado. " +
    "Responda CONFIRMAR para tentar de novo."
  );
}

export function textoDoCancelamento(): string {
  return "Manifestação descartada. Nada foi registrado.";
}

export function textoDoLimite(): string {
  return (
    "O relato atingiu o tamanho máximo que conseguimos guardar. " +
    "Responda PRONTO para conferir o resumo do que já foi anotado."
  );
}

// ---------------------------------------------------------------------------
// Reconhecimento do que a pessoa escreveu
// ---------------------------------------------------------------------------

/**
 * Minúsculas, sem acento e com os espaços colapsados.
 *
 * A comparação é sobre ESTA forma: no WhatsApp ninguém digita "CONFIRMAR" com o
 * polegar, e "Confirmo!" com acento e exclamação tem de valer.
 */
export function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Sem o ponto/exclamação final, que é ruído para as três perguntas abaixo. */
function semPontuacaoFinal(texto: string): string {
  return normalizar(texto).replace(/[.!?]+$/u, "").trim();
}

/**
 * A mensagem PEDE a Ouvidoria?
 *
 * É a porta de entrada, e ela é estreita de propósito: a Ouvidoria pode estar
 * ligada numa empresa que também vende, e desviar TODA mensagem da organização
 * pararia o funil inteiro. O que entra é o pedido explícito — a palavra
 * "ouvidoria", a "manifestação" e os verbos de reclamar/denunciar, que é como
 * quem quer reclamar começa a conversa ("gostaria de fazer uma reclamação").
 *
 * Fora daqui: "elogio" e "sugestão" soltos, que aparecem em conversa comercial
 * ("uma sugestão de horário") e não são pedido de ouvidoria.
 */
export function pedeOuvidoria(texto: string | null): boolean {
  if (!texto || texto.trim() === "") return false;
  return /\b(ouvidoria|manifesta\w*|reclama\w*|denuncia\w*)\b/u.test(normalizar(texto));
}

/**
 * A pessoa terminou de escrever o relato?
 *
 * Só a mensagem CURTA conta. "pronto, e outra coisa: o boleto veio errado"
 * continua sendo relato — o que fecha a coleta é a palavra sozinha.
 */
export function ehFimDoRelato(texto: string | null): boolean {
  if (!texto) return false;
  return /^(pronto|terminei|acabei|fim|acabou|era isso|e isso|so isso)$/u.test(
    semPontuacaoFinal(texto),
  );
}

/** A pessoa confirmou o registro? Idem: palavra sozinha, não frase. */
export function ehConfirmacao(texto: string | null): boolean {
  if (!texto) return false;
  return /^(confirmo|confirmar|confirma|sim|pode registrar|registra|registrar)$/u.test(
    semPontuacaoFinal(texto),
  );
}

/** A pessoa desistiu? */
export function ehCancelamento(texto: string | null): boolean {
  if (!texto) return false;
  return /^(cancelar|cancela|cancelado|nao|nao quero|desisto|desistir|apagar)$/u.test(
    semPontuacaoFinal(texto),
  );
}

// ---------------------------------------------------------------------------
// O relato e o resumo
// ---------------------------------------------------------------------------

/** O relato completo, do jeito que vai para a tabela: um pedaço por linha. */
export function relatoCompleto(partes: readonly string[]): string {
  return partes
    .map((parte) => parte.trim())
    .filter((parte) => parte !== "")
    .join("\n");
}

/**
 * O RESUMO apresentado antes da confirmação.
 *
 * Ele não reescreve o relato — não há modelo de linguagem neste caminho (a
 * ingestão não pode gastar uma chamada de LLM por mensagem recebida) e inventar
 * uma paráfrase de uma denúncia é pior do que repetir o texto. O que o resumo
 * faz é o que a pessoa precisa ver antes de confirmar: o relato inteiro, na
 * ordem, com os espaços colapsados, cortado num teto legível.
 */
export function resumirRelato(partes: readonly string[]): string {
  const inteiro = partes
    .map((parte) => parte.replace(/\s+/g, " ").trim())
    .filter((parte) => parte !== "")
    .join(" ");
  if (inteiro.length <= TETO_DO_RESUMO) return inteiro;

  const corte = inteiro.slice(0, TETO_DO_RESUMO);
  const ultimoEspaco = corte.lastIndexOf(" ");
  const base = (ultimoEspaco > 0 ? corte.slice(0, ultimoEspaco) : corte).trimEnd();
  return `${base}…`;
}

// ---------------------------------------------------------------------------
// O rascunho: ler, gravar, expirar
// ---------------------------------------------------------------------------

function objeto(valor: unknown): Record<string, unknown> | null {
  return valor && typeof valor === "object" && !Array.isArray(valor)
    ? (valor as Record<string, unknown>)
    : null;
}

/**
 * Lê o rascunho do `metadata` da conversa — ou `null`.
 *
 * `metadata` é jsonb escrito por fora (Inbox, scripts) e este leitor roda no
 * caminho da mensagem: nada aqui lança. Rascunho mais velho que a validade é
 * `null`, e `null` significa "conversa comum", que é o comportamento de hoje.
 */
export function lerRascunho(
  metadata: unknown,
  agora: Date = new Date(),
  validadeMs: number = VALIDADE_DO_RASCUNHO_MS,
): RascunhoDaOuvidoria | null {
  const bloco = objeto(objeto(metadata)?.[CHAVE_NO_METADATA]);
  if (!bloco) return null;

  const estado = bloco.estado;
  if (estado !== "coletando" && estado !== "confirmando") return null;

  const partes = Array.isArray(bloco.partes)
    ? bloco.partes.filter((p): p is string => typeof p === "string")
    : [];
  const atualizadoEm = typeof bloco.atualizadoEm === "string" ? bloco.atualizadoEm : "";
  const quando = Date.parse(atualizadoEm);
  if (!Number.isFinite(quando)) return null;
  if (agora.getTime() - quando > validadeMs) return null;

  return {
    estado,
    partes,
    resumo: typeof bloco.resumo === "string" ? bloco.resumo : null,
    atualizadoEm,
    ultimaMensagemId:
      typeof bloco.ultimaMensagemId === "string" ? bloco.ultimaMensagemId : null,
  };
}

/**
 * O `metadata` novo com o rascunho posto — ou limpo (`null`), quando o fluxo
 * acabou.
 *
 * Preserva todas as outras chaves: `metadata` é compartilhado com o Inbox, e
 * sobrescrever o objeto inteiro apagaria configuração de outra tela.
 */
export function comRascunho(
  metadata: unknown,
  rascunho: RascunhoDaOuvidoria | null,
): Record<string, unknown> {
  return { ...(objeto(metadata) ?? {}), [CHAVE_NO_METADATA]: rascunho };
}

// ---------------------------------------------------------------------------
// A decisão pura
// ---------------------------------------------------------------------------

export type PassoDaOuvidoria =
  /** Abriu a conversa: boas-vindas e primeiro pedaço do relato. */
  | "iniciar"
  /** Só acrescentou um pedaço; a conversa fica em silêncio de propósito. */
  | "acumular"
  /** Fechou a coleta: o resumo vai para a pessoa. */
  | "resumir"
  /** A pessoa confirmou e há o que gravar. */
  | "registrar"
  /** A pessoa desistiu. */
  | "descartar"
  /** O relato estourou o teto da tabela. */
  | "limite"
  /** Mensagem já contabilizada (reentrega do provedor). */
  | "reentrega";

export interface PerguntaDoPasso {
  texto: string | null;
  rascunho: RascunhoDaOuvidoria | null;
  /** Só para a guarda de reentrega. */
  messageId: string | null;
}

/**
 * O que fazer com ESTA mensagem, dado o rascunho da conversa.
 *
 * Separada do I/O por um motivo prático: é aqui que mora a ordem que a issue
 * cobra (coletar → resumir → confirmar → gravar), e um teste desta função mede
 * a régua sem dublê. A decisão nunca grava: quem grava é `atenderOuvidoria`.
 */
export function decidirPasso(input: PerguntaDoPasso): PassoDaOuvidoria {
  const { texto, rascunho } = input;

  // Reentrega do provedor: a MESMA mensagem não vira segundo pedaço do relato
  // nem segunda resposta. Vale em qualquer estado.
  if (rascunho && input.messageId && rascunho.ultimaMensagemId === input.messageId) {
    return "reentrega";
  }

  if (!rascunho) return pedeOuvidoria(texto) ? "iniciar" : "acumular";

  if (rascunho.estado === "confirmando") {
    if (ehCancelamento(texto)) return "descartar";
    if (ehConfirmacao(texto)) return "registrar";
    // Texto novo depois do resumo: entra no relato e o resumo é refeito.
    return "resumir";
  }

  // `coletando`
  if (ehFimDoRelato(texto)) return "resumir";
  // Confirmar/descartar antes de terminar o relato não faz sentido — a palavra
  // entra no relato como qualquer outra, e o resumo só sai no PRONTO.
  return "acumular";
}

// ---------------------------------------------------------------------------
// As portas e o orquestrador
// ---------------------------------------------------------------------------

export interface PortasDaOuvidoria {
  /** Manda o texto para a conversa. A chave é a idempotência do envio. */
  responde(entrada: { texto: string; chave: string }): Promise<void>;
  /** A gravação da fatia 1. Injetável para o teste poder falhar de propósito. */
  registra(entrada: {
    texto: string;
    canal: "whatsapp";
    contactId: string;
  }): Promise<ResultadoDoRegistro>;
  /** O relógio; injetável porque a validade do rascunho é medida nele. */
  agora?: Date;
}

export interface EntradaDaOuvidoria {
  organizationId: string;
  conversationId: string;
  contactId: string;
  messageId: string | null;
  texto: string | null;
}

export interface Atendimento {
  /**
   * `true` = esta mensagem é da Ouvidoria e a ingestão deve PARAR aqui: nada de
   * funil, nada de agente, nada de campanha.
   */
  tratado: boolean;
  /** Por que — vira log e é o que o teste lê sem adivinhar. */
  motivo:
    | "modulo_desligado"
    | "canal_fora_do_escopo"
    | "nao_e_ouvidoria"
    | "erro_de_leitura"
    | "iniciar"
    | "acumular"
    | "resumir"
    | "registrar"
    | "registro_falhou"
    | "descartar"
    | "limite"
    | "reentrega"
    | "erro_interno";
  /** Só quando a linha foi gravada — e é o protocolo DELA. */
  manifestacao?: ManifestacaoRegistrada;
}

interface ConversaDaOuvidoria {
  channel: string | null;
  metadata: unknown;
}

async function lerConversa(
  supabase: SupabaseClient,
  organizationId: string,
  conversationId: string,
): Promise<{ conversa: ConversaDaOuvidoria | null; falhou: boolean }> {
  const { data, error } = await supabase
    .from("conversations")
    .select("channel, metadata")
    .eq("organization_id", organizationId)
    .eq("id", conversationId)
    .maybeSingle();

  if (error) {
    logger.warn("[ouvidoria] leitura da conversa falhou no canal do WhatsApp", {
      organization_id: organizationId,
      conversation_id: conversationId,
      error: error.message.slice(0, 160),
    });
    return { conversa: null, falhou: true };
  }
  const linha = objeto(data);
  return {
    conversa: linha ? { channel: typeof linha.channel === "string" ? linha.channel : null, metadata: linha.metadata } : null,
    falhou: false,
  };
}

async function gravarRascunho(
  supabase: SupabaseClient,
  entrada: EntradaDaOuvidoria,
  metadata: unknown,
  rascunho: RascunhoDaOuvidoria | null,
): Promise<boolean> {
  const { error } = await supabase
    .from("conversations")
    .update({ metadata: comRascunho(metadata, rascunho) })
    .eq("organization_id", entrada.organizationId)
    .eq("id", entrada.conversationId);

  if (error) {
    logger.error("[ouvidoria] rascunho da manifestação NÃO gravado", {
      organization_id: entrada.organizationId,
      conversation_id: entrada.conversationId,
      error: error.message.slice(0, 160),
    });
    return false;
  }
  return true;
}

/**
 * Recebe uma mensagem de ENTRADA e conduz a conversa da Ouvidoria.
 *
 * Devolve sempre um `Atendimento` — nunca lança: quem chama é a ingestão, onde
 * uma exceção vira 500 para o provedor e tempestade de reentregas. A regra de
 * falha é ASSIMÉTRICA de propósito, e é a decisão mais importante deste
 * arquivo:
 *
 *   - não sabemos se a conversa é da Ouvidoria (módulo desligado, leitura da
 *     conversa falhou) → `tratado: false`, e a mensagem segue o caminho de hoje;
 *   - sabemos que É (rascunho de pé, ou o pedido explícito na mensagem) → daqui
 *     para frente `tratado: true` SEMPRE, mesmo se o envio falhar. Deixar cair
 *     no funil por causa de um erro nosso transformaria a reclamação em
 *     oportunidade de venda, que é o defeito que a issue inteira existe para
 *     fechar.
 */
export async function atenderOuvidoriaNoWhatsApp(
  supabase: SupabaseClient,
  entrada: EntradaDaOuvidoria,
  portas: PortasDaOuvidoria,
): Promise<Atendimento> {
  const agora = portas.agora ?? new Date();

  // 1) A porta de entrada do módulo. Falha de leitura aqui NÃO desvia: sem saber
  //    se o módulo está ligado, o comportamento tem de ser o de hoje.
  let ligada = false;
  try {
    const { data, error } = await supabase
      .from("organizations")
      .select("settings")
      .eq("id", entrada.organizationId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    ligada = ouvidoriaLigada(objeto(data)?.settings);
  } catch (err) {
    logger.warn("[ouvidoria] leitura da ativação falhou — ingestão segue o fluxo de hoje", {
      organization_id: entrada.organizationId,
      detail: err instanceof Error ? err.message.slice(0, 160) : "desconhecido",
    });
    return { tratado: false, motivo: "erro_de_leitura" };
  }
  if (!ligada) return { tratado: false, motivo: "modulo_desligado" };

  // 2) A conversa. Canal e rascunho saem da MESMA linha — duas leituras da mesma
  //    conversa divergiriam na primeira mensagem que chegasse no meio.
  const { conversa, falhou } = await lerConversa(
    supabase,
    entrada.organizationId,
    entrada.conversationId,
  );
  if (falhou || !conversa) return { tratado: false, motivo: "erro_de_leitura" };
  // O fluxo é do WhatsApp (fatia 2). Instagram e Facebook seguem o de hoje até
  // a fatia que os trouxer — e o desvio não pode valer para eles.
  if (conversa.channel !== "whatsapp") return { tratado: false, motivo: "canal_fora_do_escopo" };

  const rascunho = lerRascunho(conversa.metadata, agora);
  const passo = decidirPasso({ texto: entrada.texto, rascunho, messageId: entrada.messageId });

  // A partir daqui a conversa É da Ouvidoria quando: já havia rascunho, ou a
  // mensagem pediu a Ouvidoria. Qualquer erro abaixo continua sem tocar no funil.
  const daOuvidoria = rascunho !== null || passo === "iniciar";
  const chave = (sufixo: string): string =>
    `ouvidoria:${entrada.conversationId}:${entrada.messageId ?? "sem-mensagem"}:${sufixo}`;

  /** Envia, e transforma falha de envio em log — o fluxo de dados continua. */
  const responder = async (texto: string, sufixo: string): Promise<boolean> => {
    try {
      await portas.responde({ texto, chave: chave(sufixo) });
      return true;
    } catch (err) {
      logger.warn("[ouvidoria] resposta da Ouvidoria NÃO enviada", {
        organization_id: entrada.organizationId,
        conversation_id: entrada.conversationId,
        passo: sufixo,
        detail: err instanceof Error ? err.message.slice(0, 160) : "desconhecido",
      });
      return false;
    }
  };

  const gravar = (novo: RascunhoDaOuvidoria | null) =>
    gravarRascunho(supabase, entrada, conversa.metadata, novo);

  try {
    if (passo === "reentrega") return { tratado: daOuvidoria, motivo: "reentrega" };

    // ── Nada de rascunho e nada de Ouvidoria nesta mensagem: comportamento de
    //    hoje, sem tocar em nada.
    if (!daOuvidoria) return { tratado: false, motivo: "nao_e_ouvidoria" };

    // ── INICIAR: boas-vindas, e a própria mensagem já é o primeiro pedaço. Quem
    //    escreve "gostaria de fazer uma reclamação: o pedido não chegou" não
    //    pode ter a reclamação descartada em nome da cortesia.
    if (passo === "iniciar") {
      const partes = entrada.texto && entrada.texto.trim() !== "" ? [entrada.texto] : [];
      await gravar({
        estado: "coletando",
        partes,
        resumo: null,
        atualizadoEm: agora.toISOString(),
        ultimaMensagemId: entrada.messageId,
      });
      await responder(textoInicial(), "boas-vindas");
      return { tratado: true, motivo: "iniciar" };
    }

    // `rascunho` não é nulo daqui para baixo: `daOuvidoria` só é verdadeiro sem
    // rascunho no passo `iniciar`, que já retornou.
    const atual = rascunho as RascunhoDaOuvidoria;

    // ── DESCARTAR
    if (passo === "descartar") {
      await gravar(null);
      await responder(textoDoCancelamento(), "cancelamento");
      return { tratado: true, motivo: "descartar" };
    }

    // ── REGISTRAR: a gravação vem PRIMEIRO, e a resposta depende dela. É a
    //    garantia central da issue, e a ordem não é estilo: um `await` invertido
    //    aqui manda para o cliente um protocolo que não existe.
    if (passo === "registrar") {
      const texto = relatoCompleto(atual.partes);
      const resultado = await portas.registra({
        texto,
        canal: "whatsapp",
        contactId: entrada.contactId,
      });

      if (!resultado.ok) {
        // O rascunho fica DE PÉ (inclusive o `ultimaMensagemId`, que impede a
        // reentrega de contar duas vezes): a pessoa responde CONFIRMAR de novo
        // e a tentativa recomeça, sem reescrever o relato.
        await responder(textoDaFalha(), "falha");
        logger.error("[ouvidoria] manifestação NÃO registrada — o cliente não recebe protocolo", {
          organization_id: entrada.organizationId,
          conversation_id: entrada.conversationId,
          motivo: resultado.erro,
        });
        return { tratado: true, motivo: "registro_falhou" };
      }

      // Registrada: agora sim a confirmação, com o protocolo DA LINHA gravada
      // (o que `registrarManifestacao` leu de volta no INSERT).
      await gravar(null);
      await responder(
        textoDaConfirmacao(resultado.manifestacao.protocolo),
        `confirmacao:${resultado.manifestacao.protocolo}`,
      );
      logger.info("[ouvidoria] manifestação registrada pelo WhatsApp", {
        organization_id: entrada.organizationId,
        conversation_id: entrada.conversationId,
        manifestacao_id: resultado.manifestacao.id,
        protocolo: resultado.manifestacao.protocolo,
      });
      return { tratado: true, motivo: "registrar", manifestacao: resultado.manifestacao };
    }

    // ── ACUMULAR / RESUMIR: o texto novo entra no relato (ou estoura o teto).
    const novo = (entrada.texto ?? "").trim();
    const partes = novo === "" ? atual.partes : [...atual.partes, novo];
    const inteiro = relatoCompleto(partes);

    if (inteiro.length > TEXTO_MAXIMO) {
      // Não grava a parte que estourou nem limpa o rascunho: o relato já
      // coletado continua inteiro, e a pessoa é convidada a fechar.
      await responder(textoDoLimite(), "limite");
      return { tratado: true, motivo: "limite" };
    }

    // Em `coletando`, acumular é SILÊNCIO: responder cada mensagem de um relato
    // que chega em cinco partes gasta o número cinco vezes e atropela a pessoa.
    if (passo === "acumular") {
      await gravar({
        estado: "coletando",
        partes,
        resumo: null,
        atualizadoEm: agora.toISOString(),
        ultimaMensagemId: entrada.messageId,
      });
      return { tratado: true, motivo: "acumular" };
    }

    // ── RESUMIR: o resumo é apresentado e a conversa passa a esperar a
    //    confirmação. Nada é gravado na tabela da fatia 1 aqui.
    //
    // A palavra que FECHOU a coleta ("pronto", "terminei") não entra no relato:
    // ela é comando, não manifestação. Deixá-la dentro faria a linha gravada
    // terminar em "pronto" — e a ouvidoria leria um pedido de reclamação com
    // uma palavra de comando colada no fim.
    const partesDoResumo = ehFimDoRelato(entrada.texto) ? atual.partes : partes;
    const resumo = resumirRelato(partesDoResumo);
    await gravar({
      estado: "confirmando",
      partes: partesDoResumo,
      resumo,
      atualizadoEm: agora.toISOString(),
      ultimaMensagemId: entrada.messageId,
    });
    await responder(textoDoResumo(resumo, partesDoResumo.length), "resumo");
    return { tratado: true, motivo: "resumir" };
  } catch (err) {
    // Erro nosso em conversa que JÁ identificamos como da Ouvidoria: `tratado`
    // continua verdadeiro para a ingestão não abrir card nenhum.
    logger.error("[ouvidoria] fluxo do WhatsApp falhou (a mensagem não vira card)", {
      organization_id: entrada.organizationId,
      conversation_id: entrada.conversationId,
      detail: err instanceof Error ? err.message.slice(0, 160) : "desconhecido",
    });
    return { tratado: daOuvidoria, motivo: "erro_interno" };
  }
}

/**
 * As portas de PRODUÇÃO, no molde de `aviso-fora-do-horario.ts`: import
 * dinâmico nos dois lados caros (o handler de envio e a gravação), para que o
 * topo deste arquivo carregue num teste unitário sem ambiente, sem `@/lib/env`
 * e sem a cadeia de guardrails do envio.
 */
export function portasDaOuvidoria(
  supabase: SupabaseClient,
  entrada: EntradaDaOuvidoria,
): PortasDaOuvidoria {
  return {
    async responde({ texto, chave }) {
      const { sendMessageHandler } = await import("@/app/api/v1/messages/_handler");
      await sendMessageHandler(
        supabase as never,
        {
          organization_id: entrada.organizationId,
          // Autoria AUTOMAÇÃO: quem escreveu foi uma regra do módulo, não a IA
          // nem uma pessoa — é o vocabulário de `messages.sent_via`.
          actor: { type: "webhook_source", id: "ouvidoria" },
          requestId: chave,
        },
        {
          conversation_id: entrada.conversationId,
          type: "text",
          body: texto,
          metadata: { idempotency_key: chave, [MARCA_DA_RESPOSTA]: true },
        },
      );
    },

    async registra({ texto, canal, contactId }) {
      return registrarManifestacao(
        { supabase, organizationId: entrada.organizationId },
        { texto, canal, contactId },
      );
    },
  };
}
