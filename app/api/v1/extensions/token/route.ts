import { randomUUID } from "node:crypto";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { fail, ok } from "@/lib/api/wrappers";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import {
  emitirTokenDoModulo,
  lerCabecalhosDaBusca,
  MENSAGEM_DE_RECUSA,
} from "@/lib/extensions/token-do-modulo";

export const dynamic = "force-dynamic";

const JANELA_SEGUNDOS = 60;
const TETO_POR_IP_E_INSTALACAO = 20;
const TETO_POR_INSTALACAO = 60;

const SEM_CACHE = { "Cache-Control": "no-store" };

/**
 * Busca do token curto de um módulo `connected` (spec 33, F2, tarefa 5).
 *
 * Rota do MÓDULO, sem sessão: entra em `lib/auth/public-paths.ts` só neste caminho exato. A identidade
 * é a assinatura HMAC com o segredo da instalação (`X-Module-*`), nunca o corpo (ignorado) nem um
 * Bearer. Toda recusa de autenticação tem o mesmo status e o mesmo corpo; só 429 (rate limit) e 5xx
 * (falha nossa) diferem. Sem `requireSupportWrite`: não há cookie nem ator para a guarda ler (a
 * exceção está em `tests/unit/suporte-cobertura-de-efeitos.test.ts`).
 */
export async function POST(request: Request): Promise<Response> {
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
  if (ip !== null) baldes.push([`mod-token:ip:${ip}:${entrada.installationId}`, TETO_POR_IP_E_INSTALACAO]);
  baldes.push([`mod-token:inst:${entrada.installationId}`, TETO_POR_INSTALACAO]);
  for (const [balde, teto] of baldes) {
    const limite = await checkRateLimit(balde, teto, JANELA_SEGUNDOS);
    if (!limite.allowed) {
      return fail("rate_limited", "Muitas tentativas. Aguarde antes de repetir.", 429, {
        requestId,
        headers: { ...SEM_CACHE, "Retry-After": String(JANELA_SEGUNDOS) },
      });
    }
  }

  // 3 a 8.
  const resultado = await emitirTokenDoModulo(entrada, requestId);
  if (!resultado.ok) {
    if (resultado.motivo === "indisponivel") {
      return fail("internal_error", "Não foi possível concluir o pedido agora. Tente de novo.", 503, {
        requestId,
        headers: SEM_CACHE,
      });
    }
    return recusa();
  }
  return ok({ token: resultado.token, expires_at: resultado.expires_at }, { requestId, headers: SEM_CACHE });
}
