import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/system/update — o clique do dono.
 *
 * Não executa nada: cria o run em `dispatched` e marca o pedido. Quem executa é
 * o agente do host, no próximo heartbeat. O app escreve APENAS esta transição —
 * é o único instante em que ele sabe com certeza que a ordem saiu.
 *
 * ## O corpo: `{ force: true }` (#2756)
 *
 * O botão "Forçar atualização" da tela manda a INTENÇÃO, nunca um comando. O
 * `--to` é derivado AQUI, a partir do mesmo run de falha que a tela leu para
 * montar o comando que ela mostra ao lado do botão — os dois têm de ser o mesmo
 * alvo: a tela chama `comandoDeVolta(run.from_version)`, este arquivo chama
 * `alvoDeVolta(run.from_version)`, e `UpdatePanel.test.tsx` costura os dois com
 * um teste de espelho.
 *
 * A força é também o ÚNICO jeito de atravessar o 409 "você já está na versão
 * mais recente": depois de uma falha o `git checkout` já tinha dado certo, o
 * host passa a reportar a versão ALVO e `current` coincide com `latest`. Sem
 * `--force` o próprio `update.sh` responderia a mesma coisa e sairia com 0 —
 * o falso sucesso que desligava o botão.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { falhaDaEscritaDePlatformAdmin, requirePlatformAdminEscrita } from "@/lib/auth/requirePlatformAdmin";
import { loadAuthUser } from "@/lib/auth/server";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { alvoDeVolta } from "@/lib/system/update-force";
import { isRunStale, rollbackDesmentidoPeloApp, rollbackFoiSuperado } from "@/lib/system/update-run";

export const dynamic = "force-dynamic";

const RUN_IN_PROGRESS_MESSAGE = "Já existe uma atualização em andamento.";

/**
 * O corpo aceito. `{}` e corpo ausente viram `force: false` — o botão normal
 * de sempre segue batendo exatamente como batia. `force` que não é booleano é
 * 422, nunca "força silenciosamente": quem pediu força tem de saber que não
 * recebeu.
 */
const corpoDoPedido = z.object({ force: z.boolean().optional().default(false) });

/** O que a derivação do alvo precisa ler do run mais recente. */
const COLUNAS_DO_RUN_ANTERIOR = "from_version, to_version, status, finished_at";

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const user = await loadAuthUser();
  // `unauthenticated` (não `unauthorized`): esse último é reservado ao segredo
  // interno das rotas host↔app (lib/api/errors.ts); aqui falta é sessão.
  if (!user) return fail("unauthenticated", "Faça login para continuar.", 401);
  // Atualizar o servidor é ESCRITA da instalação: support_readonly e sessão com
  // dívida de MFA não disparam. O 401 acima fica: sem sessão é `unauthenticated`.
  try {
    await requirePlatformAdminEscrita();
  } catch (err) {
    return falhaDaEscritaDePlatformAdmin(err, undefined, "Só o dono do servidor pode atualizar o sistema.");
  }

  const parseado = corpoDoPedido.safeParse((await req.json().catch(() => null)) ?? {});
  if (!parseado.success) {
    return fail("validation_failed", 'Corpo inválido: envie {"force": true} ou nenhum corpo.', 422, {
      details: parseado.error.flatten(),
    });
  }
  const force = parseado.data.force;

  const db = createAdminClient();
  const { data: version, error: versionError } = await db
    .from("system_version")
    .select("current_version, latest_version, updated_at")
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

  // Só a força passa por aqui: `latest === current` é exatamente o estado de
  // falha que o botão existe para sair (o código já está na versão nova).
  if (!force && (!latest || latest === current)) {
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
    // faz a escrita só valer se ainda estiver "dispatched" nesse instante — se
    // o agente reportar o desfecho real bem nesse meio-tempo, esta escrita não
    // pega nada e o run real prevalece.
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

  // ── O alvo da força, derivado do run que a tela está mostrando (#2756) ────
  //
  // Mesma linha de raciocínio da tela: numa falha, a versão que resolve é a de
  // onde o run SAIU (`run.from_version`), não a que ele tentou instalar — o
  // `current_version` do host nomeia a versão que quebrou. A derivação vem
  // antes do INSERT, que é o que passa a ser o "mais recente".
  //
  // Falha JÁ SUPERADA por um deploy posterior não recebe alvo: a tela nem
  // mostra o botão nesse estado (`falhaVigente`), e forçar um retorno para uma
  // versão que ninguém mais está usando seria o clique velho vencendo o deploy
  // novo. O mesmo corte, com as mesmas funções e os mesmos campos — se um dos
  // dois lados mudar, o teste de espelho da tela acusa.
  let forceTarget = "";
  if (force) {
    const { data: anterior, error: anteriorError } = await db
      .from("system_update_runs")
      .select(COLUNAS_DO_RUN_ANTERIOR)
      .order("dispatched_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (anteriorError) {
      // Silêncio aqui mudaria a AÇÃO: o botão executaria `--force` sem `--to`
      // enquanto a tela ao lado prometia o retorno para a versão anterior.
      // Reprovar alto é o único desfecho honesto.
      logger.error("[system/update] leitura do run anterior falhou", { error: anteriorError.message });
      return fail("internal_error", "Não consegui montar o pedido de força.", 500);
    }
    const ehFalha = anterior?.status === "failed" || anterior?.status === "failed_rolled_back";
    const superada =
      rollbackFoiSuperado(version?.updated_at, anterior?.finished_at, current, anterior) ||
      rollbackDesmentidoPeloApp(anterior, process.env.APP_VERSION);
    if (ehFalha && !superada) {
      forceTarget = alvoDeVolta(anterior?.from_version);
    }
  }

  // `to_version` do run de força é o que ELE vai instalar, não o `latest` do
  // batimento: numa falha o host costuma nem anunciar tag (o alvo já está no
  // HEAD), e a tela diria "atualizando para a versão " com o nome vazio. Sem
  // isto o `just_updated` também afirmaria que a versão NOVA terminou depois
  // de um retorno bem-sucedido.
  const toVersion = force && forceTarget ? forceTarget : latest;

  const { data: run, error } = await db
    .from("system_update_runs")
    .insert({
      from_version: current,
      to_version: toVersion,
      status: "dispatched",
      requested_by: user.id,
      force_requested: force,
      force_target: forceTarget,
    })
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
    // bate na constraint. Isso é o MESMO estado de negócio do check acima (já
    // existe um run em andamento), não uma falha de infraestrutura.
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
    metadata: {
      from_version: current,
      to_version: toVersion,
      ...(force ? { force: true, force_target: forceTarget } : {}),
    },
    actingAsPlatformAdmin: true,
  });

  // O 200 volta com a mutação do cliente; como estivemos no servidor, ainda vale
  // a mesma regra: não cachear o clique — o próximo clique seria para um run
  // que já não existe mais.
  const resposta = ok({ run_id: run.id, to_version: toVersion });
  resposta.headers.set("Cache-Control", "no-store");
  return resposta;
}
