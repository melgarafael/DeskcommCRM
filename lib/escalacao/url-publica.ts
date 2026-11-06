/**
 * ESTA INSTALAÇÃO TEM UM ENDEREÇO QUE ABRE NO CELULAR DE OUTRA PESSOA?
 *
 * Pergunta de INSTALAÇÃO, e ela só aparece quando o produto manda um link para
 * FORA — o aviso de caso no WhatsApp é o primeiro caso. Dentro do navegador a
 * pergunta nunca precisou ser feita: quem já está na tela chegou por um endereço
 * que funciona, por definição.
 *
 * Três endereços passam por `new URL()` e não servem:
 *
 *   - `http://localhost:3000` — o DEFAULT de `NEXT_PUBLIC_APP_URL` em
 *     `lib/env.ts`. Toda instalação que nunca preencheu a variável tem este;
 *   - `https://placeholder.invalid` — a imagem genérica do self-host é
 *     BUILDADA com ele (variável `NEXT_PUBLIC_` é substituída no build, não no
 *     boot). `app/api/v1/channels/official/route.ts` já o trata, e esta função
 *     é a mesma guarda ampliada;
 *   - host privado (`app`, `192.168.*`, `10.*`) — resolve dentro da rede do
 *     Docker ou da LAN e em lugar nenhum fora dela.
 *
 * Mora em `lib/` e não em `app/` de propósito: o teste a importa sem arrastar
 * rota nenhuma, e o handler do aviso não é uma rota.
 *
 * ⚠️ NÃO é uma checagem de alcançabilidade. Ela não resolve DNS nem faz
 * requisição — um domínio real com DNS quebrado passa aqui. O que ela garante é
 * que o endereço NÃO é um dos que sabidamente não saem da máquina, que é a
 * classe que produz um aviso com link morto sem nenhum erro em lugar nenhum.
 */

/** Esquemas por onde um link de WhatsApp abre. */
const ESQUEMAS = new Set(["http:", "https:"]);

/** O host do placeholder do build. TLD reservado — nunca resolve. */
const PLACEHOLDER = "placeholder.invalid";

/** `true` quando o host só existe dentro desta máquina ou desta rede. */
function hostPrivado(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "127.0.0.1" || h.startsWith("127.") || h === "::1" || h === "[::1]") return true;
  if (h === "0.0.0.0") return true;
  // Faixas privadas de IPv4 (RFC 1918) e link-local.
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(h)) return true;
  // Nome de serviço do compose (`app`, `worker`): host SEM ponto nenhum. Um
  // domínio público sempre tem pelo menos um.
  if (!h.includes(".")) return true;
  return false;
}

/** `true` quando dá para pôr este endereço dentro de uma mensagem. */
export function urlPublicaUsavel(bruto: string | null | undefined): boolean {
  if (typeof bruto !== "string" || bruto.trim() === "") return false;
  let url: URL;
  try {
    url = new URL(bruto.trim());
  } catch {
    return false;
  }
  if (!ESQUEMAS.has(url.protocol)) return false;
  const host = url.hostname.toLowerCase();
  if (host === PLACEHOLDER || host.endsWith(`.${PLACEHOLDER}`)) return false;
  return !hostPrivado(host);
}

/**
 * O endereço do caso. Uma função, e não um template no chamador: a rota do caso
 * já está escrita em `REFERENCIAS_DE_AVISO.agent_case`
 * (`lib/ai/inbox-destino.ts`), e uma terceira cópia dela divergiria no dia em
 * que a tela mudasse de lugar.
 */
export function linkDoCaso(base: string, caseId: string): string {
  return `${base.replace(/\/+$/, "")}/app/ai/cases?caso=${caseId}`;
}

/**
 * O endereço do negócio para quem está FORA do navegador (#2642). Aponta para
 * `/app/leads/<id>`, a URL estável do lead: o funil fica de fora de propósito,
 * porque o lead muda de funil e a página resolve o quadro certo na hora.
 */
export function linkDoNegocio(base: string, leadId: string): string {
  return `${base.replace(/\/+$/, "")}/app/leads/${leadId}`;
}
