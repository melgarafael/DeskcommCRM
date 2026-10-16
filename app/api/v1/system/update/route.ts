import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/system/update — o clique do dono.
 *
 * Não executa nada: cria o run em `dispatched` e marca o pedido. Quem executa é
 * o agente do host, no próximo heartbeat. O app escreve APENAS esta transição —
 * é o único instante em que ele sabe com certeza que a ordem saiu.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { falhaDaEscritaDePlatformAdmin, requirePlatformAdminEscrita } from "@/lib/auth/requirePlatformAdmin";
import { loadAuthUser } from "@/lib/auth/server";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { ehVersaoPublicada, isRunStale } from "@/lib/system/update-run";

export const dynamic = "force-dynamic";

const RUN_IN_PROGRESS_MESSAGE = "Já existe uma atualização em andamento.";
const SEM_FALHA_PARA_DESFAZER = "Não há nenhuma atualização com falha para desfazer agora.";

/**
 * O corpo é lido com folga de propósito: o clique antigo da própria tela manda
 * `{}` (e uma versão ainda mais antiga nem corpo manda). Recusar corpo
 * malformado aqui quebraria o "Atualizar agora" para consertar o "Voltar" — a
 * única pergunta que este corpo faz é se o pedido é uma VOLTA.
 */
const corpoDoPedido = z.object({ rollback: z.boolean().optional() });

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const user = await loadAuthUser();
  // `unauthenticated` (não `unauthorized`): esse último é reservado ao segredo
  // interno das rotas host↔app (lib/api/errors.ts) — aqui falta é sessão.
  if (!user) return fail("unauthenticated", "Faça login para continuar.", 401);
  // Atualizar o servidor é ESCRITA da instalação: support_readonly e sessão com
  // dívida de MFA não disparam. O 401 acima fica: sem sessão é `unauthenticated`.
  try {
    await requirePlatformAdminEscrita();
  } catch (err) {
    return falhaDaEscritaDePlatformAdmin(err, undefined, "Só o dono do servidor pode atualizar o sistema.");
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

  const corpo = corpoDoPedido.safeParse(await req.json().catch(() => ({})));
  const querVoltar = corpo.success && corpo.data.rollback === true;

  // ── A volta para a versão anterior (#2757) ──────────────────────────────
  //
  // O pedido de VOLTAR não é uma atualização qualquer: o alvo é a versão de
  // onde a última tentativa SAIU (`from_version`), nunca a última publicada —
  // instalar a publicada seria reinstalar a release que acabou de quebrar. O
  // `--to … --force` que a tela mostra é este mesmo run, executado pelo
  // agente do host; aqui só se registra a ordem, como em todo pedido.
  //
  // O alvo sai do ÚLTIMO run, e ele tem de ser uma FALHA: run de sucesso não
  // tem o que desfazer, e pegar o `from_version` de um run velho qualquer
  // devolveria o sistema para uma versão que ninguém acabou de sair.
  let alvoDaVolta = "";
  if (querVoltar) {
    const { data: ultimaTentativa, error: leituraFalha } = await db
      .from("system_update_runs")
      .select("id, status, from_version")
      .order("dispatched_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (leituraFalha) {
      logger.error("[system/update] leitura do run da volta falhou", { error: leituraFalha.message });
      return fail("internal_error", "Não consegui ler a última atualização.", 500);
    }

    const falhou =
      ultimaTentativa?.status === "failed" || ultimaTentativa?.status === "failed_rolled_back";
    const de = (ultimaTentativa?.from_version ?? "").trim();
    if (!falhou || !de) return fail("state_conflict", SEM_FALHA_PARA_DESFAZER, 409);

    // O MESMO critério do `comandoDeVolta` da tela: só há volta com NOME
    // quando a versão de onde se saiu é uma versão publicada. Fora dela
    // (instalação numa marca de desenvolvimento) não existe imagem publicada
    // para trás — e a saída continua sendo o comando de refazer, que a tela
    // mantém à vista.
    if (!ehVersaoPublicada(de)) {
      return fail(
        "state_conflict",
        "Não sei para qual versão voltar: a última atualização saiu de uma instalação sem versão publicada. Quem tem acesso ao servidor pode rodar o comando que a tela mostra.",
        409,
      );
    }
    // O agente faz `update.sh --to <isto>`, e as tags do repositório levam o
    // "v" — `git describe` devolve com ele, mas nem toda fonte guarda assim.
    alvoDaVolta = /^v/i.test(de) ? de : `v${de}`;
  }

  if (!querVoltar && (!latest || latest === current)) {
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

  // O alvo do run: a volta pedida (#2757), ou — no caminho de sempre — a
  // última release publicada. `to_version` é o que viaja para o agente no
  // próximo heartbeat, e é por isso que os dois caminhos fecham na MESMA
  // coluna: uma ordem só, com um alvo só.
  const alvo = alvoDaVolta || latest;

  const { data: run, error } = await db
    .from("system_update_runs")
    .insert({ from_version: current, to_version: alvo, status: "dispatched", requested_by: user.id })
    .select()
    .single();

  if (error) {
    // A preparação de extensão e a atualização dividem a mesma cerca no
    // banco (migration 0271). A recusa tem uma saída pela gestão, não é uma pane.
    if (error.code === "P0001" && error.message === "extension_preparation_in_progress") {
      return fail(
        "state_conflict",
        "Há uma extensão em preparação. Abra Extensões: em Atividade recente, quem pediu pode retomar o pedido, e qualquer responsável pela instalação pode cancelá-lo antes de atualizar o sistema.",
        409,
      );
    }
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
    // `rollback` distingue o pedido de voltar do de atualizar: são a MESMA
    // ação no banco e no agente, e a auditoria é o lugar onde os dois ficam
    // separados para sempre.
    metadata: { from_version: current, to_version: alvo, rollback: querVoltar },
    actingAsPlatformAdmin: true,
  });

  return ok({ run_id: run.id, to_version: alvo });
}
