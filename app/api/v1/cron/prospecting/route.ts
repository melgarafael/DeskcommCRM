import { randomUUID } from "node:crypto";
import { env } from "@/lib/env";
import { ok, fail } from "@/lib/api/wrappers";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { createAdminClient } from "@/lib/supabase/admin";
import { tickProspecting } from "@/lib/prospecting/worker";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
async function handle(req: Request) {
  const requestId = randomUUID();
  const value = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "")?.[1];
  const accepted = [env.INTERNAL_CRON_SECRET, env.INTERNAL_SECRET].filter(Boolean);
  if (!value || !accepted.includes(value))
    return fail("forbidden", "Credencial de execução inválida.", 403, { requestId });
  try {
    return ok(await tickProspecting(getRequestPool(), createAdminClient()), { requestId });
  } catch (err) {
    // O `catch` era SEM PARÂMETRO: o objeto do erro não ficava de fora do log,
    // ele era DESCARTADO — não existia em variável nenhuma. Num cron, que roda
    // sozinho e sem ninguém olhando, isso significava que a prospecção da
    // instalação inteira podia parar e a única evidência ser um 500 numa
    // resposta que ninguém lê.
    const detalhe = err instanceof Error ? err.message : String(err);
    logger.error("[prospecting.cron] tickProspecting lançou", { error: detalhe, requestId });
    // O detalhe vai na resposta, como o routing-worker faz: quem chama o cron à
    // mão para investigar merece ler a causa, não uma frase genérica.
    return fail("internal_error", detalhe, 500, { requestId });
  }
}
export const GET = handle;
export const POST = handle;
