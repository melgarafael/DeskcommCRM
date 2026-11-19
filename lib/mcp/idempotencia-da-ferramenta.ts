/**
 * Idempotência das ferramentas MCP que ENVIAM mensagem (#1613, item B).
 *
 * `crm_send_whatsapp_message`, `crm_send_material` e
 * `crm_start_conversation_and_send` aceitam `idempotency_key` e cada uma fazia
 * a sua idempotência à mão: lia o recibo, enviava e só DEPOIS gravava. Daí três
 * defeitos, medidos em `lib/mcp/tools/messages.test.ts` e
 * `lib/mcp/tools/start-conversation.test.ts`:
 *   1. duas chamadas simultâneas com a mesma chave liam vazio as duas e
 *      enviavam as duas — a chave existia justamente para não acontecer;
 *   2. o `request_hash` era calculado e nunca comparado: a mesma chave com
 *      OUTRO texto devolvia a resposta da primeira, e o texto novo não saía;
 *   3. `expires_at` não era filtrado: um recibo vencido seguia valendo.
 * (E o hash ia como hex cru para a coluna `bytea`, que nunca casa na releitura —
 * o cabeçalho de `lib/api/idempotency.ts` explica.)
 *
 * O conserto não é uma quarta implementação: é o helper que a rota REST
 * (`app/api/v1/messages/route.ts`, item A) e a publicação de Status
 * (`lib/channels/publicacao-de-status.ts`) já usam. A chave é RESERVADA antes
 * do efeito; quem perde a corrida recebe "em curso" e não executa nada.
 *
 * ── O que entra no efeito ───────────────────────────────────────────────────
 * Tudo o que tem consequência: o freio anti-ban do número (que pode esperar até
 * 5 s e conta o envio no ledger), a abertura da conversa, a cópia do material e
 * o envio. Um replay, um conflito ou um "em curso" não gastam o freio — não
 * enviaram nada. Validação e recusa sem efeito (corpo inválido, contato
 * pessoal) ficam ANTES, fora do recibo: uma recusa não vira resposta gravada
 * por 24 h.
 *
 * ── A identidade do pedido ──────────────────────────────────────────────────
 * O hash sai dos argumentos que CHEGARAM, menos a própria chave — nunca de um
 * valor resolvido pelo efeito (o `conversation_id` que a abertura devolve, por
 * exemplo). É a mesma regra comentada na rota REST: resolver é o efeito que a
 * chave existe para não repetir. Todo argumento entra, inclusive os que vierem
 * a existir: argumento novo fora do hash faria dois pedidos diferentes
 * parecerem o mesmo (replay errado); dentro, o pior caso é um conflito.
 *
 * ── Os erros ────────────────────────────────────────────────────────────────
 * Conflito e "em curso" são `ApiError` 409 com os códigos da REST
 * (`idempotency_conflict`, `idempotency_in_progress`). O servidor MCP
 * (`lib/mcp/server.ts`) devolve ao cliente só a MENSAGEM do erro, então o código
 * vai no começo dela — a mesma forma de `crm_publish_whatsapp_status`.
 *
 * ── Recibos de antes desta mudança ──────────────────────────────────────────
 * Os `endpoint` continuam os mesmos. Um recibo gravado pelo código antigo (hash
 * em hex cru) não casa com hash nenhum: dentro das 24 h dele, a repetição da
 * mesma chave recebe `idempotency_conflict` em vez do replay. É o lado seguro —
 * não reenvia — e some sozinho quando o recibo vence.
 */
import { comIdempotencia } from "@/lib/api/idempotency";
import { ApiError } from "@/lib/api/types";
import type { McpContext } from "./types";

/** O status que o recibo guarda: o das ferramentas, que respondem sempre 200. */
const STATUS_DO_RECIBO = 200;

export async function enviarComChave<T extends Record<string, unknown>>(entrada: {
  ctx: Pick<McpContext, "supabase" | "organizationId" | "requestId">;
  /** A tag do recibo; a mesma de antes desta mudança, para cada ferramenta. */
  endpoint: string;
  /** Os argumentos da ferramenta como CHEGARAM, com ou sem `idempotency_key`. */
  argumentos: { idempotency_key?: string } & Record<string, unknown>;
  /** O efeito inteiro: freio, abertura, envio. Só roda para quem reservar a chave. */
  executar: () => Promise<T>;
}): Promise<T | (T & { deduplicated: true })> {
  const { ctx, endpoint, argumentos, executar } = entrada;
  const { idempotency_key: chave, ...pedido } = argumentos;

  // Sem chave, o caminho é o de sempre: executa, sem recibo nenhum.
  if (!chave) return executar();

  const desfecho = await comIdempotencia<T>({
    db: ctx.supabase,
    // Do token, nunca dos argumentos: `ctx` é resolvido pelo servidor MCP.
    organizationId: ctx.organizationId,
    endpoint,
    chave,
    corpo: pedido,
    executar: async () => ({ resposta: await executar(), status: STATUS_DO_RECIBO }),
  });

  switch (desfecho.tipo) {
    case "executou":
      return desfecho.resposta;
    case "replay":
      // A resposta da primeira execução, sem reenviar — o contrato de sempre.
      return { ...desfecho.resposta, deduplicated: true };
    case "conflito":
      throw new ApiError(
        409,
        "idempotency_conflict",
        undefined,
        ctx.requestId,
        "idempotency_conflict: esta chave de idempotência já foi usada com outro conteúdo. Nada foi enviado; para um envio novo, use uma chave nova.",
      );
    case "em_curso":
      throw new ApiError(
        409,
        "idempotency_in_progress",
        undefined,
        ctx.requestId,
        "idempotency_in_progress: o mesmo pedido, com esta chave, ainda está em curso. Nada foi enviado de novo; tente outra vez em instantes, com a mesma chave.",
      );
  }
}
