/**
 * Teto de chamadas do MCP server (Spec 11 §7).
 *
 * ─── Por que esta porta precisa de teto ─────────────────────────────────────
 * O `/api/mcp` não passa por filtro nenhum antes da rota: ele está em
 * `lib/auth/public-paths.ts` de propósito ("público aqui quer dizer 'o proxy
 * não decide', não 'sem autenticação'"), porque a identidade vem do Bearer e
 * não do cookie. A consequência é que NÃO existe estrangulamento a montante —
 * o que não for contado aqui não é contado em lugar nenhum.
 *
 * ─── Os três tetos, e por que são três ──────────────────────────────────────
 * Por TOKEN (60/min) — a unidade natural: um integrador, um token.
 *
 * Por ORGANIZAÇÃO (600/min) — não é redundante com o de cima. `api_tokens`
 * (baseline.sql:1259) não limita QUANTOS tokens uma organização emite: quem
 * quer mais cota emite mais token, e o teto por token vira contornável por
 * quem já está dentro. O agregado é o que fecha isso.
 *
 * Por ESCRITA (30/min) — o mais apertado, e é o que protege o número de
 * WhatsApp. `crm_send_whatsapp_message` é escrita, e o canal por QR é
 * cliente não-oficial: o WhatsApp restringe e bane por VOLUME, e bane o
 * NÚMERO, não a sessão. Um agente de terceiro em laço não derruba o servidor —
 * derruba o número da operação, e disso não há desfazer.
 *
 * ⚠️ A Spec §7 diz "sliding window Upstash". `checkRateLimit` é janela FIXA
 * (INCR + EXPIRE), que admite um burst de até 2x no limiar de duas janelas.
 * Implementamos o que EXISTE e é testado, em vez de infra nova: para 60/min a
 * granularidade basta, e a mesma escolha já vale para login, pairing code e
 * dispatcher. Se o burst virar problema medido, aí sim troca-se o motor — em
 * um lugar só, porque todos os chamadores passam por `checkRateLimit`.
 *
 * ⚠️ Sem Redis, `checkRateLimit` conta EM MEMÓRIA e avisa alto ("not safe for
 * multi-instance"). Em várias instâncias o teto efetivo vira N×60. Continua
 * barrando — não é fail-open —, mas o operador que roda replicado precisa do
 * Redis para o número valer. A escolha é da função compartilhada, não daqui.
 */
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";

import { McpAuthError } from "./auth";
import type { McpAuthResult } from "./auth";
import type { McpToolCategory } from "./types";

/** Spec 11 §7 — os três números, em um lugar só. */
export const TETO_POR_TOKEN = 60;
export const TETO_POR_ORGANIZACAO = 600;
export const TETO_DE_ESCRITA = 30;
export const JANELA_SEGUNDOS = 60;

/** MCP error code para 429 (Spec 11 §2.3). */
const MCP_RATE_LIMITED = -32004;

/**
 * Cobra os tetos ANTES de a tool rodar. Estoura `McpAuthError(-32004)`.
 *
 * O erro é `McpAuthError` de propósito, e não uma classe nova: o `catch` do
 * `server.ts` já transforma qualquer erro em `{ isError: true }` E o audita em
 * `api_audit_log` com `success: false`. Recusa silenciosa seria pior que não
 * ter teto — "o agente parou" viraria mistério sem rastro.
 *
 * A ordem também é deliberada: vem antes de `ensureScope`/`ensureRole` porque
 * quem está em laço estourando o teto não deve pagar o custo de mais nada.
 */
export async function verificarTetoMcp(
  auth: McpAuthResult,
  categoria: McpToolCategory,
): Promise<void> {
  const ehEscrita = categoria === "write";

  // Sequencial, e não `Promise.all`: o `allowed` de cada bucket INCREMENTA o
  // contador. Disparar os três sempre faria a chamada já recusada pelo teto do
  // token consumir também a cota da organização — o agente em laço queimaria a
  // cota agregada de quem não fez nada.
  const porToken = await checkRateLimit(
    `mcp:tok:${auth.apiTokenId}`,
    TETO_POR_TOKEN,
    JANELA_SEGUNDOS,
  );
  if (!porToken.allowed) throw recusa("token");

  const porOrganizacao = await checkRateLimit(
    `mcp:org:${auth.organizationId}`,
    TETO_POR_ORGANIZACAO,
    JANELA_SEGUNDOS,
  );
  if (!porOrganizacao.allowed) throw recusa("organização");

  if (!ehEscrita) return;

  const porEscrita = await checkRateLimit(
    `mcp:w:${auth.apiTokenId}`,
    TETO_DE_ESCRITA,
    JANELA_SEGUNDOS,
  );
  if (!porEscrita.allowed) throw recusa("escrita");
}

/**
 * A mensagem diz QUAL teto e QUANDO tentar de novo.
 *
 * Quem lê isto é um modelo decidindo o próximo passo: "rate limited" sozinho
 * não diz se vale esperar ou se a chamada está errada. Com a janela explícita,
 * o agente pode aguardar em vez de repetir o laço que causou a recusa.
 */
function recusa(qual: string): McpAuthError {
  return new McpAuthError(
    MCP_RATE_LIMITED,
    429,
    `Teto de chamadas do MCP excedido (${qual}). Tente de novo em ${JANELA_SEGUNDOS}s.`,
  );
}
