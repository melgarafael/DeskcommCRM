import { randomUUID } from "node:crypto";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { fail, ok } from "@/lib/api/wrappers";
import {
  LIMITE_MAXIMO_DE_EVENTOS,
  LIMITE_PADRAO_DE_EVENTOS,
  lerEventosDoModulo,
} from "@/lib/extensions/eventos-do-modulo";
import { lerCabecalhosDaBusca, MENSAGEM_DE_RECUSA } from "@/lib/extensions/token-do-modulo";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";

export const dynamic = "force-dynamic";

const JANELA_SEGUNDOS = 60;
const TETO_POR_IP_E_INSTALACAO = 30;
const TETO_POR_INSTALACAO = 120;

const SEM_CACHE = { "Cache-Control": "no-store" };

/**
 * Leitura dos eventos de um módulo `connected` por cursor (spec 33, F5).
 *
 * Rota do MÓDULO, sem sessão: entra em `lib/auth/public-paths.ts` só neste caminho exato. A identidade é
 * a mesma assinatura HMAC da busca de token (`X-Module-*`), conferida DENTRO de `lerEventosDoModulo`, com
 * carimbo, nonce de uso único e rate limit; vale também depois de o token ter sido revogado. A organização
 * vem SÓ dos cabeçalhos assinados (nunca da query nem do corpo) e o banco confere o par organização ×
 * instalação. Toda recusa de autenticação ou autorização tem o mesmo status e o mesmo corpo da busca de
 * token; só 400 (cursor ou limite inválido, e só depois de autenticado), 429 e 5xx diferem.
 *
 * É leitura: sem audit, sem `Idempotency-Key` e sem `requireSupportWrite` (a guarda cobre só POST, PUT,
 * PATCH e DELETE). O cursor recebido reconhece o anterior; o efeito de gravar o cursor lido é do banco.
 */
export async function GET(request: Request): Promise<Response> {
  const requestId = randomUUID();
  const recusa = () =>
    fail("module_auth_failed", MENSAGEM_DE_RECUSA, 401, { requestId, headers: SEM_CACHE });

  // 1. formato.
  const entrada = lerCabecalhosDaBusca(request.headers);
  if (!entrada) return recusa();

  // 2. rate limit: um balde por IP + instalação e outro só por instalação. Sem IP identificável, só o
  // da instalação (um balde global trancaria todos os módulos).
  const ip = ipDoCliente(request.headers)?.slice(0, 64) ?? null;
  const baldes: Array<[string, number]> = [];
  if (ip !== null) baldes.push([`mod-events:ip:${ip}:${entrada.installationId}`, TETO_POR_IP_E_INSTALACAO]);
  baldes.push([`mod-events:inst:${entrada.installationId}`, TETO_POR_INSTALACAO]);
  for (const [balde, teto] of baldes) {
    const limite = await checkRateLimit(balde, teto, JANELA_SEGUNDOS);
    if (!limite.allowed) {
      return fail("rate_limited", "Muitas tentativas. Aguarde antes de repetir.", 429, {
        requestId,
        headers: { ...SEM_CACHE, "Retry-After": String(JANELA_SEGUNDOS) },
      });
    }
  }

  // 3. a query: só `cursor` e `limit`. Valor mal formado vira o que a leitura recusa DEPOIS de autenticar.
  const { searchParams } = new URL(request.url);
  const cursorBruto = searchParams.get("cursor");
  const cursor = cursorBruto === null || cursorBruto === "" ? null : cursorBruto;
  const limiteBruto = searchParams.get("limit");
  const limite =
    limiteBruto === null
      ? LIMITE_PADRAO_DE_EVENTOS
      : /^[0-9]{1,4}$/.test(limiteBruto)
        ? Number(limiteBruto)
        : -1;

  // 4 em diante: prova, autorização, cursor, ack, leitura.
  const resultado = await lerEventosDoModulo(entrada, cursor, limite, requestId);
  if (!resultado.ok) {
    switch (resultado.motivo) {
      case "indisponivel":
        return fail("internal_error", "Não foi possível concluir o pedido agora. Tente de novo.", 503, {
          requestId,
          headers: SEM_CACHE,
        });
      case "cursor_invalido":
        return fail("invalid_cursor", "O cursor é inválido para este módulo.", 400, {
          requestId,
          headers: SEM_CACHE,
        });
      case "limite_invalido":
        return fail(
          "validation_failed",
          `O limite precisa ser um inteiro de 1 a ${LIMITE_MAXIMO_DE_EVENTOS}.`,
          400,
          { requestId, headers: SEM_CACHE },
        );
      default:
        return recusa();
    }
  }
  return ok(
    { events: resultado.events, next_cursor: resultado.next_cursor, has_more: resultado.has_more },
    { requestId, headers: SEM_CACHE },
  );
}
