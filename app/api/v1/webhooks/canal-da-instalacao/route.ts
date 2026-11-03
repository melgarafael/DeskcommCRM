/**
 * POST /api/v1/webhooks/canal-da-instalacao — a entrada do webhook ÚNICO da
 * instalação, por onde chegam os eventos de TODOS os números conectados com um
 * clique.
 *
 * ─── Por que existe, ao lado da rota por token ──────────────────────────────
 *
 * A rota `channel/[token]` resolve a sessão pelo token do caminho: uma
 * assinatura de webhook por número. O provedor limita as assinaturas por conta
 * e recomenda um endpoint para todos os clientes, roteado pela conta. Aqui não
 * há token: `resolverEntradaDaInstalacao` confere a assinatura com o segredo da
 * instalação e acha a sessão pela conta (ou pelo número) do próprio evento.
 *
 * Achada a sessão, o processamento é EXATAMENTE o da rota por token
 * (`processarEntradaDoCanal`): arquivo do corpo cru, conta, ingestão e as
 * mesmas respostas.
 *
 * ─── As respostas ───────────────────────────────────────────────────────────
 *
 *   - 404 sem webhook registrado nesta instalação (como token desconhecido);
 *   - 401 assinatura que não confere, com rastro no log;
 *   - 200 `ignored` para evento que não é de nenhuma conexão de um clique: o
 *     provedor reentrega o que não recebeu 200;
 *   - 500 só para falha de ESCRITA, que é quando a reentrega é o que queremos;
 *   - 200 `accepted` para mensagem nova, ANTES de processá-la: o arquivo do
 *     webhook a guardou e a ingestão roda depois da resposta; 503 quando nem o
 *     arquivo gravou (`_entrada-do-canal.ts`).
 *
 * O caminho é público no `proxy.ts` pelo prefixo `/api/v1/webhooks/`
 * (`lib/auth/public-paths.ts`): quem autentica é a assinatura.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { resolverEntradaDaInstalacao } from "@/lib/channels/entrada-da-instalacao";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

import { processarEntradaDoCanal } from "../_entrada-do-canal";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const rawBody = await req.text();
  const admin = createAdminClient();

  let entrada: Awaited<ReturnType<typeof resolverEntradaDaInstalacao>>;
  try {
    entrada = await resolverEntradaDaInstalacao(admin, rawBody, req.headers);
  } catch (err) {
    return fail("internal_error", err instanceof Error ? err.message : "lookup_failed", 500, {
      requestId,
    });
  }

  if (entrada.tipo === "recusa") {
    if (entrada.status === 404) {
      return fail("not_found", "unknown webhook", 404, { requestId });
    }
    logger.warn("[webhook-da-instalacao] assinatura recusada", { request_id: requestId });
    return fail("unauthorized", entrada.motivo, 401, { requestId });
  }
  if (entrada.tipo === "ignorar") {
    return ok({ status: "ignored", reason: entrada.motivo }, { requestId });
  }

  return processarEntradaDoCanal(admin, {
    sessao: entrada.sessao,
    rawBody,
    headers: req.headers,
    secret: entrada.secret,
    requestId,
  });
}
