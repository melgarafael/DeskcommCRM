/**
 * GET /api/v1/auth/realtime-token — o token que o canal Realtime precisa.
 *
 * Por que existe: o cookie de sessão é httpOnly (CLAUDE.md), então o
 * supabase-js do browser NÃO enxerga a sessão e assina os canais como ANÔNIMO.
 * O Realtime aplica RLS por canal: canal anônimo assina, recebe "ok", e nunca
 * recebe evento nenhum — falha silenciosa que parece saúde. O fetch do board já
 * tinha sido movido para rota de API por essa mesma razão (ver useBoard);
 * o realtime ficou para trás.
 *
 * A sessão continua morando no cookie httpOnly. Isto entrega apenas o
 * access_token, em memória, para o cliente autenticar o WebSocket — nunca
 * gravado em storage, e some no reload.
 *
 * NÃO ESTENDA ESTE ENDPOINT. Ele existe para UM consumidor: o socket do
 * Realtime. Precisa de token no browser para outra coisa? A resposta certa é
 * rota de API no servidor, não mais um campo aqui — senão a exceção vira porta.
 *
 * `cache-control: no-store` é obrigatório e não é zelo abstrato: o corpo de
 * sucesso É um token de sessão, e o deploy tem Caddy na frente. Um 200 cacheado
 * serviria o token de um usuário para outro. O repo já decidiu isso duas vezes
 * para carga MENOS sensível — as rotas de QR (`channel-sessions/[id]/qr`,
 * `onboarding/whatsapp/qr`) setam no-store porque um QR é segredo.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { loadAuthUser } from "@/lib/auth/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store, max-age=0" } as const;

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const supabase = await createClient();

  // `loadAuthUser` valida o JWT no servidor (caminho central, com cache) — é ele
  // que autoriza a resposta.
  const user = await loadAuthUser();
  if (!user) {
    return fail("unauthenticated", "Auth required.", 401, { requestId, headers: NO_STORE });
  }

  // getSession() aqui NÃO autentica (o getUser acima já autenticou): serve só
  // para extrair o token que o cookie httpOnly guarda.
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.access_token) {
    return fail("unauthenticated", "Sessão sem token.", 401, { requestId, headers: NO_STORE });
  }

  return ok(
    { access_token: session.access_token, expires_at: session.expires_at ?? null },
    { requestId, headers: NO_STORE },
  );
}
