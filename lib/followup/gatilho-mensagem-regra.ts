/**
 * A REGRA dos gatilhos de entrada por mensagem (Automações, grupo 2), pura.
 *
 *   - `keyword`       — palavra-chave: a mensagem contém, é igual ou começa com
 *                       uma das palavras;
 *   - `ref_link`      — link/QR de entrada: o link `wa.me` preenche a mensagem
 *                       com `#codigo`, e a mensagem que traz o código dispara;
 *   - `ad_click`      — anúncio de clique para o WhatsApp: a mensagem chegou de
 *                       um clique em anúncio (atribuição gravada pela ingestão);
 *   - `default_reply` — resposta padrão: nada mais respondeu à mensagem.
 *
 * Os dois lados que precisam da MESMA resposta leem daqui: o produtor
 * (`gatilho-mensagem.ts`, que inscreve) e o silenciador do agente
 * (`ceder-turno-ao-gatilho-de-mensagem.ts`, que deixa o fluxo falar sozinho).
 * Uma regra por lado divergiria na primeira palavra nova — e a divergência é
 * exatamente o cliente recebendo duas vozes.
 *
 * Funciona igual na API oficial e no WAHA: só lê o TEXTO da mensagem e a
 * atribuição de anúncio, que os dois transportes gravam no mesmo formato.
 */

export const MODOS_DA_PALAVRA = ["contem", "exato", "comeca_com"] as const;
export type ModoDaPalavra = (typeof MODOS_DA_PALAVRA)[number];

/** Código de link de entrada: minúsculas, números e hífen. */
export const PADRAO_DO_CODIGO = /^[a-z0-9][a-z0-9-]{2,39}$/;

/** Janela em que a atribuição de anúncio gravada conta como "esta mensagem veio do anúncio". */
export const JANELA_DO_ANUNCIO_MS = 10 * 60 * 1000;

/**
 * Mensagem mais velha que isto não dispara gatilho: é backlog (worker parado,
 * reentrega), e um fluxo de "promo" respondendo horas depois é pior que nada.
 */
export const JANELA_DA_MENSAGEM_MS = 30 * 60 * 1000;

/** Ordem de prioridade: o mais específico ganha o único slot vivo do contato. */
export const PRIORIDADE_DO_GATILHO = {
  ref_link: 0,
  keyword: 1,
  ad_click: 2,
} as const;

export type GatilhoEspecifico =
  | { kind: "keyword"; palavras: string[]; modo: ModoDaPalavra }
  | { kind: "ref_link"; codigo: string }
  | { kind: "ad_click"; anuncios: string[] };

export interface FatosDaMensagem {
  texto: string | null;
  /** `contacts.source_metadata` — o que a ingestão gravou do clique no anúncio. */
  anuncio: { ad_id: string | null; ad_source_id: string | null; capturado_em: Date | null } | null;
  /** Quando a mensagem foi gravada (`messages.created_at`). */
  recebida_em: Date;
}

/** minúsculas, sem acento, pontuação vira espaço, espaços colapsados. */
export function normalizarTexto(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}#-]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Normaliza e descarta palavra vazia ou repetida — o que a tela grava. */
export function limparPalavras(palavras: readonly string[]): string[] {
  const vistas = new Set<string>();
  for (const p of palavras) {
    const n = normalizarTexto(p).replace(/#/g, "").trim();
    if (n) vistas.add(n);
  }
  return [...vistas];
}

export function casaPalavraChave(texto: string | null, palavras: readonly string[], modo: ModoDaPalavra): boolean {
  if (!texto) return false;
  const msg = normalizarTexto(texto).replace(/#/g, "").trim();
  if (!msg) return false;
  for (const bruta of palavras) {
    const p = normalizarTexto(bruta).replace(/#/g, "").trim();
    if (!p) continue;
    if (modo === "exato" && msg === p) return true;
    if (modo === "comeca_com" && (msg === p || msg.startsWith(`${p} `))) return true;
    // "contém" casa PALAVRA inteira, não pedaço: "oi" não casa "boi".
    if (modo === "contem" && ` ${msg} `.includes(` ${p} `)) return true;
  }
  return false;
}

/** O texto que o link `wa.me` preenche: a frase do operador + `#codigo`. */
export function textoDoLinkDeEntrada(codigo: string, frase?: string | null): string {
  const f = (frase ?? "").trim();
  return f ? `${f} #${codigo}` : `#${codigo}`;
}

/** `https://wa.me/<numero>?text=...` — só dígitos no número. */
export function linkDeEntrada(numero: string, codigo: string, frase?: string | null): string {
  const digitos = numero.replace(/\D/g, "");
  return `https://wa.me/${digitos}?text=${encodeURIComponent(textoDoLinkDeEntrada(codigo, frase))}`;
}

export function casaCodigoDoLink(texto: string | null, codigo: string): boolean {
  if (!texto) return false;
  const alvo = `#${codigo.toLowerCase()}`;
  return normalizarTexto(texto)
    .split(" ")
    .some((pedaco) => pedaco === alvo);
}

export function veioDeAnuncio(fatos: FatosDaMensagem, anuncios: readonly string[]): boolean {
  const a = fatos.anuncio;
  if (!a || !a.capturado_em) return false;
  // A ingestão grava a atribuição ANTES dos efeitos pós-entrada, no mesmo
  // request da mensagem. Atribuição velha é de uma conversa antiga: o contato
  // já tinha vindo do anúncio e agora escreveu outra coisa.
  if (Math.abs(fatos.recebida_em.getTime() - a.capturado_em.getTime()) > JANELA_DO_ANUNCIO_MS) return false;
  if (anuncios.length === 0) return true;
  return anuncios.some((id) => id === a.ad_id || id === a.ad_source_id);
}

export function gatilhoCasa(gatilho: GatilhoEspecifico, fatos: FatosDaMensagem): boolean {
  switch (gatilho.kind) {
    case "keyword":
      return casaPalavraChave(fatos.texto, gatilho.palavras, gatilho.modo);
    case "ref_link":
      return casaCodigoDoLink(fatos.texto, gatilho.codigo);
    case "ad_click":
      return veioDeAnuncio(fatos, gatilho.anuncios);
  }
}

/**
 * Os ponteiros que casam, do mais específico ao menos; empate pela ordem de
 * entrada (o produtor passa por `id` para ser determinístico).
 */
export function ordenarCandidatos<T extends { gatilho: GatilhoEspecifico }>(
  pointers: readonly T[],
  fatos: FatosDaMensagem,
): T[] {
  return pointers
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => gatilhoCasa(p.gatilho, fatos))
    .sort((a, b) => PRIORIDADE_DO_GATILHO[a.p.gatilho.kind] - PRIORIDADE_DO_GATILHO[b.p.gatilho.kind] || a.i - b.i)
    .map(({ p }) => p);
}

/** A resposta padrão pausa por contato: já respondeu há menos de `intervalo_horas`? */
export function respostaPadraoEmPausa(ultima: Date | null, agora: Date, intervaloHoras: number): boolean {
  if (!ultima) return false;
  return agora.getTime() - ultima.getTime() < intervaloHoras * 60 * 60 * 1000;
}
