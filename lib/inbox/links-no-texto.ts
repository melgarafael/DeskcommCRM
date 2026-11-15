/**
 * ENDEREÇO NO MEIO DO TEXTO — o que é link e o que é texto (#4576).
 *
 * ─── Por que existe ─────────────────────────────────────────────────────────
 * O corpo da mensagem do Inbox sempre foi UMA string dentro de um `<p>`: no
 * WhatsApp o endereço é clicável, aqui não era. A saída óbvia — montar HTML e
 * jogar em `dangerouslySetInnerHTML` — está proibida: o corpo vem do cliente
 * (e do provedor), é o dado mais hostil que a tela recebe. Este módulo NÃO
 * produz marcação: devolve PEDAÇOS, e quem monta a âncora é o React, com o
 * `href` que passou pela régua de protocolo abaixo. Texto que não é endereço
 * sai byte a byte como entrou — espaço, quebra de linha e `<b>` inclusive.
 *
 * ─── A régua de protocolo é a segurança ────────────────────────────────────
 * Só `http:` e `https:` viram âncora. `javascript:`, `data:`, `vbscript:`,
 * `file:` e qualquer outro esquema não casam no candidato e, mesmo que
 * casassem, o `href` é revalidado por `new URL` — duas barreiras, porque a
 * segunda continua valendo se alguém afrouxar a primeira.
 *
 * ─── Formas aceitas ────────────────────────────────────────────────────────
 *   1. `https://…` / `http://…`      → href igual ao texto;
 *   2. `www.…` sem protocolo         → href com `https://`;
 *   3. domínio solto com TLD conhecido (`loja.exemplo.com.br`) → `https://`.
 *
 * A forma 3 tem lista FECHADA de TLD: sem ela, `contrato.pdf`, `v1.2.3` e
 * `reunião.amanhã` virariam link — o relato é sobre endereço, e falso link é
 * pior que link faltando. E-mail (`contato@empresa.com`) não casa porque a
 * fronteira recusa o `@` colado à esquerda.
 */

/** Um pedaço do texto: literal, ou endereço já com o `href` resolvido. */
export interface ParteDoTexto {
  /** Exatamente o que estava escrito no corpo — nada é reescrito. */
  texto: string;
  /** Só existe quando o pedaço é endereço aceito (`http:`/`https:`). */
  href?: string;
}

/** TLDs que a forma solta aceita. Lista fechada de propósito (ver cabeçalho). */
const TLDS = [
  "com\\.br",
  "net\\.br",
  "org\\.br",
  "gov\\.br",
  "edu\\.br",
  "com",
  "net",
  "org",
  "gov",
  "edu",
  "mil",
  "int",
  "br",
  "io",
  "dev",
  "app",
  "co",
  "me",
  "tv",
  "info",
  "biz",
  "shop",
  "store",
  "site",
  "online",
  "tech",
  "cloud",
  "link",
  "bio",
  "art",
  "design",
  "pro",
  "ai",
  "xyz",
].join("|");

/**
 * Candidato a endereço. As três alternativas estão em ordem de especificidade:
 * quem começa com esquema ou `www.` é consumido pela primeira, e a terceira só
 * pega domínio solto cujo TLD está na lista — com caminho opcional, porque
 * `loja.exemplo.com.br/pedido/9` é um endereço inteiro, não só o host.
 */
const CANDIDATO = new RegExp(
  `(?:https?:\\/\\/|www\\.)[^\\s<>"'\`]+` +
    `|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+(?:${TLDS})(?![a-z0-9.-])` +
    `(?:[/?#][^\\s<>"'\`]*)?`,
  "gi",
);

/** Letra, número ou caractere de URL imediatamente antes: não é início de link. */
const COLA_NA_FRENTE = /[\p{L}\p{N}_@/.-]/u;

/** Pontuação que fecha a frase e não faz parte do endereço. */
const PONTUACAO_FINAL = ".,;:!?…\"'”’»";

/** Par de fechamento → abertura correspondente (parêntese balanceado fica). */
const PARES: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

function contar(texto: string, alvo: string): number {
  let total = 0;
  for (const c of texto) if (c === alvo) total++;
  return total;
}

/**
 * Devolve o endereço sem a pontuação que pertence à FRASE, não a ele:
 * `https://x.com/a.` → `https://x.com/a`, `(https://x.com/a)` → sem o `)`,
 * mas `.../Foo_(bar)` mantém o parêntese porque ele está aberto dentro do link.
 */
function semPontuacaoDaFrase(bruto: string): string {
  let fim = bruto.length;
  while (fim > 0) {
    const ultimo = bruto[fim - 1]!;
    if (PONTUACAO_FINAL.includes(ultimo)) {
      fim--;
      continue;
    }
    const abre = PARES[ultimo];
    if (abre) {
      const dentro = bruto.slice(0, fim);
      if (contar(dentro, ultimo) > contar(dentro, abre)) {
        fim--;
        continue;
      }
    }
    break;
  }
  return bruto.slice(0, fim);
}

/**
 * `href` do endereço, ou `null` quando ele não é navegável.
 *
 * `www.` e domínio solto ganham `https://`. O valor devolvido é o TEXTO
 * original (com o esquema acrescentado), não o `URL.toString()` — o `toString`
 * acrescenta `/` no fim e a bolha passaria a mostrar um endereço que ninguém
 * escreveu.
 */
export function hrefDoEndereco(endereco: string): string | null {
  const comEsquema =
    /^(?:www\.|[a-z0-9-]+\.)/i.test(endereco) && !/^https?:\/\//i.test(endereco)
      ? `https://${endereco}`
      : endereco;
  let url: URL;
  try {
    url = new URL(comEsquema);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  // `https://` sozinho, `https://` + espaço: host sem ponto não é endereço.
  if (!url.hostname.includes(".") || url.hostname.startsWith(".") || url.hostname.endsWith(".")) {
    return null;
  }
  return comEsquema;
}

/**
 * Parte o texto em pedaços de texto e endereços. O que não é endereço sai
 * intacto e na ordem original; a concatenação de `parte.texto` é SEMPRE igual
 * ao texto de entrada (é o que garante que a bolha não reformata nada).
 */
export function partesComLinks(texto: string): ParteDoTexto[] {
  if (!texto) return [];
  const partes: ParteDoTexto[] = [];
  let cursor = 0;

  for (const achado of texto.matchAll(CANDIDATO)) {
    const inicio = achado.index ?? 0;
    const antes = inicio > 0 ? texto[inicio - 1]! : "";
    // Endereço colado a uma palavra (`xhttps://…`) é texto, não link.
    if (antes && COLA_NA_FRENTE.test(antes)) continue;

    const endereco = semPontuacaoDaFrase(achado[0]);
    const href = hrefDoEndereco(endereco);
    if (!href) continue;

    if (inicio > cursor) partes.push({ texto: texto.slice(cursor, inicio) });
    partes.push({ texto: endereco, href });
    cursor = inicio + endereco.length;
  }

  if (cursor < texto.length) partes.push({ texto: texto.slice(cursor) });
  return partes;
}
