import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/system/update — o clique do dono.
 *
 * Não executa nada: cria o run em `dispatched` e marca o pedido. Quem executa é
 * o agente do host, no próximo heartbeat. O app escreve APENAS esta transição —
 * é o único instante em que ele sabe com certeza que a ordem saiu.
 */
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { loadAuthUser } from "@/lib/auth/server";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { isRunStale } from "@/lib/system/update-run";

export const dynamic = "force-dynamic";

const RUN_IN_PROGRESS_MESSAGE = "Já existe uma atualização em andamento.";

export async function POST(_req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const user = await loadAuthUser();
  // `unauthenticated` (não `unauthorized`): esse último é reservado ao segredo
  // interno das rotas host↔app (lib/api/errors.ts) — aqui falta é sessão.
  if (!user) return fail("unauthenticated", "Faça login para continuar.", 401);
  if (!user.is_platform_admin) {
    return fail("forbidden", "Só o dono do servidor pode atualizar o sistema.", 403);
  }

  const db = createAdminClient();
  const { data: version, error: versionError } = await db
    .from("system_version")
    .select("current_version, latest_version")
    .eq("id", 1)
    .maybeSingle();

  // Sem checar o erro, uma falha de leitura (outage, rede) vira `current`/
  // `latest` vazios — e cai direto no 409 "você já está em dia" abaixo. É a
  // pior mensagem possível bem na hora de uma falha de infraestrutura.
  if (versionError) {
    logger.error("[system/update] leitura de system_version falhou", { error: versionError.message });
    return fail("internal_error", "Não consegui ler o estado da atualização.", 500);
  }

  const current = version?.current_version ?? "";
  const latest = version?.latest_version ?? "";

  if (!latest || latest === current) {
    return fail("state_conflict", "Você já está na versão mais recente.", 409);
  }

  const { data: running } = await db
    .from("system_update_runs")
    .select("id, status, dispatched_at")
    .eq("status", "dispatched")
    .order("dispatched_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (running) {
    if (!isRunStale(running.dispatched_at, new Date())) {
      return fail("state_conflict", RUN_IN_PROGRESS_MESSAGE, 409);
    }
    // Run "dispatched" vencido (>15min, RUN_STALE_AFTER_MS): o agente do host
    // morreu no meio (crash, VPS reiniciada, bug) sem nunca reportar o
    // desfecho. Sem isto, o índice único parcial (migration 0090) + o 409
    // acima travariam QUALQUER novo pedido pra sempre — o botão morreria em
    // silêncio até alguém abrir o banco à mão. Fechamos como `failed` (não é
    // o agente reportando via run_result; é o PRÓPRIO app declarando
    // inconclusivo) e seguimos com o pedido novo. `.eq("status","dispatched")`
    // faz a escrita só valer se ainda estiver "dispatched" nesse instante —
    // se o agente reportar o desfecho real bem nesse meio-tempo, esta escrita
    // não pega nada e o run real prevalece.
    const { error: staleError } = await db
      .from("system_update_runs")
      .update({
        status: "failed",
        finished_at: new Date().toISOString(),
        log_tail: "Run abandonado: o agente do host não reportou o desfecho a tempo (agente parado ou travado).",
      })
      .eq("id", running.id)
      .eq("status", "dispatched");
    if (staleError) {
      logger.error("[system/update] não consegui expirar o run travado", {
        error: staleError.message,
        runId: running.id,
      });
      return fail("internal_error", "Não consegui liberar a atualização travada.", 500);
    }
  }

  const { data: run, error } = await db
    .from("system_update_runs")
    .insert({ from_version: current, to_version: latest, status: "dispatched", requested_by: user.id })
    .select()
    .single();

  if (error) {
    // O índice único parcial `uniq_system_update_runs_dispatched` (migration
    // 0090) é a garantia de banco contra dois cliques quase simultâneos: o
    // check acima (`running`) é só otimização, não exclusão mútua — sob
    // corrida, os dois requests podem passar por ele e só o segundo INSERT
    // bate na constraint. Isso é o MESMO estado de negócio do check acima
    // (já existe um run em andamento), não uma falha de infraestrutura.
    if (error.code === "23505") {
      return fail("state_conflict", RUN_IN_PROGRESS_MESSAGE, 409);
    }
    logger.error("[system/update] insert do run falhou", { error: error.message });
    return fail("internal_error", "Não consegui registrar o pedido de atualização.", 500);
  }

  if (!run) {
    return fail("internal_error", "Não consegui registrar o pedido de atualização.", 500);
  }

  // O run criado acima é a ordem — e é a ÚNICA. Havia aqui um segundo write
  // (`update_requested_at/by` em `system_version`) que respondia à mesma
  // pergunta sem transação e sem checar erro: falhando ele, a rota respondia
  // 200, a tela mostrava a barra de passos e o agente nunca pegava o pedido.
  // Quem pediu e quando já vive no próprio run (`requested_by`,
  // `dispatched_at`) e no audit log abaixo.

  await audit({
    action: "system.update_requested",
    actorUserId: user.id,
    resourceType: "system_update_run",
    resourceId: run.id,
    metadata: { from_version: current, to_version: latest },
    actingAsPlatformAdmin: true,
  });

  return ok({ run_id: run.id, to_version: latest });
}
