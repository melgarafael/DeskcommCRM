/**
 * POST /api/v1/system/agent — endpoint ÚNICO do agente do host.
 *
 * O app não alcança o host: quem puxa é o `agent.sh`, por cron. Ele anuncia a
 * versão instalada e lê, na resposta, se alguém clicou em "Atualizar agora".
 * O que atravessa a fronteira é um booleano, nunca um comando — mesmo com o app
 * comprometido, o atacante não escolhe O QUE roda no host.
 *
 * Auth: `Authorization: Bearer <INTERNAL_CRON_SECRET|INTERNAL_SECRET>`, mesmo
 * esquema das demais rotas de cron. Nunca em query string.
 */
import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { CHANGELOG_MAX_BYTES } from "@/lib/system/changelog";
import { canTransition, type RunStatus } from "@/lib/system/update-run";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const heartbeat = z.object({
  kind: z.literal("heartbeat"),
  current_version: z.string().max(64),
  current_sha: z.string().max(64),
  off_release: z.boolean(),
  latest_version: z.string().max(64),
  // "não consegui comparar" ≠ "não há nada novo". Opcional com default: o
  // container do app atualiza antes do script do host (é literalmente o
  // bootstrap desta feature), e um agente antigo não pode passar a receber 422
  // — ele voltaria a ficar mudo, que é o defeito que este campo existe para
  // impedir.
  compare_failed: z.boolean().optional().default(false),
  // "não anunciei tag" ≠ "nunca houve tag publicada" — a mesma dúvida do
  // campo acima, mas para distinguir "à frente da última publicada" de
  // "este fork nunca teve release nenhuma". Default `true` (não `false`) por
  // compatibilidade: um agente antigo sem este campo preserva o comportamento
  // anterior ("à frente da publicada"), em vez de virar silenciosamente
  // "nunca houve release" para todo mundo.
  has_known_release: z.boolean().optional().default(true),
  changelog: z.string().max(CHANGELOG_MAX_BYTES),
});

const runProgress = z.object({
  kind: z.literal("run_progress"),
  run_id: z.string().uuid(),
  step: z.enum(["backup", "codigo", "banco"]),
});

const runResult = z.object({
  kind: z.literal("run_result"),
  run_id: z.string().uuid(),
  status: z.enum(["success", "failed", "failed_rolled_back"]),
  log_tail: z.string().max(16_000),
  // O que a rodada do banco contou de si mesma: se a base estava ocupada, quantas
  // retentativas custou e em qual passada fechou. Ausente quando o kit não mediu
  // (rodada que não passou pelo banco) — e aí a tela fica calada, não afirma zero.
  disputa_de_banco: z.boolean().optional(),
  retentativas_do_banco: z.number().int().min(0).optional(),
  passada_do_banco: z.number().int().min(1).optional(),
});

/**
 * A volta que ninguém pediu (#2757).
 *
 * Quando o app não responde duas vezes seguidas nas 2 h depois de uma
 * atualização, o `agent.sh` volta a versão sozinho e manda este recado. Sem
 * ele, a volta ficava registrada só no `.update-agent.log` do servidor: quem
 * abre o painel vê a versão mudar e não tem como saber o que houve — o defeito
 * que o mantenedor apontou como o terceiro ajuste.
 *
 * `returned_to` é a versão em que o sistema ESTÁ agora; `failed_version` é a
 * que não respondeu. Os dois nomes são explícitos de propósito: "de/para" é
 * ambíguo numa volta (de qual lado?), e foi assim que esta rota já errou antes.
 *
 * `ok` é o DESFECHO da volta (#3271) — `true` quando o `update.sh --to` da
 * volta terminou com código 0. Ele não existia, e por isso o painel tratava
 * igual a volta que terminou bem e a que falhou: a tela dizia "é a que está no
 * ar agora" nos dois casos e oferecia o botão de voltar apontando para a versão
 * que já estava rodando. O campo é OPCIONAL por compatibilidade (o container do
 * app atualiza antes do script do host — ver `compare_failed`), e ausente quer
 * dizer "ninguém mediu o desfecho"; a rota trata isso como não terminado, para
 * não afirmar o que ninguém provou (ver o ramo `rollback` no `POST`).
 */
const rollback = z.object({
  kind: z.literal("rollback"),
  returned_to: z.string().min(1).max(64),
  failed_version: z.string().min(1).max(64),
  ok: z.boolean().optional(),
  reason: z.string().max(2_000),
});

const body = z.discriminatedUnion("kind", [heartbeat, runProgress, runResult, rollback]);

/**
 * As três colunas da rodada do banco, numa escrita própria e best-effort.
 *
 * Não devolve nada e nunca lança: quem decide o desfecho da atualização é a
 * escrita de `status` logo depois, e uma coluna de frase não pode impedir o run
 * de fechar (o `post` do agente recebe vazio a cada 500 e o run ficaria preso em
 * `dispatched` para sempre). Ausente no payload = nada é escrito: `null` é "não
 * medido", e a tela distingue isso de zero.
 */
async function gravarRodadaDoBanco(
  db: ReturnType<typeof createAdminClient>,
  payload: {
    run_id: string;
    disputa_de_banco?: boolean;
    retentativas_do_banco?: number;
    passada_do_banco?: number;
  },
): Promise<void> {
  const mediu =
    payload.disputa_de_banco !== undefined ||
    payload.retentativas_do_banco !== undefined ||
    payload.passada_do_banco !== undefined;
  if (!mediu) return;

  const { error } = await db
    .from("system_update_runs")
    .update({
      disputa_de_banco: payload.disputa_de_banco ?? null,
      retentativas_do_banco: payload.retentativas_do_banco ?? null,
      passada_do_banco: payload.passada_do_banco ?? null,
    })
    .eq("id", payload.run_id);

  if (error) {
    logger.warn("[system/agent] a rodada do banco não foi gravada — o run fecha assim mesmo", {
      error: error.message,
      runId: payload.run_id,
    });
  }
}

function secretMatches(provided: string): boolean {
  const accepted = [env.INTERNAL_CRON_SECRET, env.INTERNAL_SECRET].filter(Boolean);
  return accepted.some((expected) => {
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    // timingSafeEqual LANÇA se os tamanhos diferirem — o curto-circuito aqui
    // evita que um segredo de tamanho errado vire 500 em vez de 401.
    return a.length === b.length && timingSafeEqual(a, b);
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const provided = bearer || (req.headers.get("x-cron-secret")?.trim() ?? "");
  if (!provided || !secretMatches(provided)) {
    return fail("unauthorized", "Credencial inválida.", 401);
  }

  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Corpo inválido.", 422, { details: parsed.error.flatten() });
  }

  const db = createAdminClient();
  const payload = parsed.data;

  if (payload.kind === "heartbeat") {
    const { error } = await db
      .from("system_version")
      .update({
        current_version: payload.current_version,
        current_sha: payload.current_sha,
        off_release: payload.off_release,
        latest_version: payload.latest_version,
        compare_failed: payload.compare_failed,
        has_known_release: payload.has_known_release,
        changelog_raw: payload.changelog,
        agent_last_seen_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", 1);
    if (error) {
      logger.error("[system/agent] heartbeat falhou", { error: error.message });
      return fail("internal_error", "Não consegui gravar o estado.", 500);
    }

    // "Há pedido?" tem UMA fonte de verdade: o run em `dispatched`. O flag
    // `update_requested_at` respondia a mesma pergunta por outro caminho — e
    // como os dois writes do POST /update não são uma transação, bastava o
    // segundo falhar para o app responder 200, a tela mostrar a barra de
    // passos por 15 minutos e o agente nunca ver o pedido. Um estado só, o que
    // o agente executa, não pode divergir do que a tela mostra.
    //
    // O `to_version` sai junto (#2757): a ordem não é sempre "instale a
    // última release" — o botão de voltar cria um run cujo alvo é a versão
    // ANTERIOR, e o agente que instalasse a última publicada estaria
    // reinstalando justamente a release que quebrou. O agente aplica o `--force`
    // sozinho, quando o git mostrar que o alvo pedido é mais antigo que o que
    // já roda aqui; daqui só viaja o alvo.
    //
    // O índice único parcial `uniq_system_update_runs_dispatched` (migration
    // 0090) garante no máximo 1 linha "dispatched" — mas o `postgrest-js` NÃO
    // lança se, apesar disso, o SELECT achar mais de uma linha: devolve
    // `{ data: null, error: PGRST116 }`. Ler isso como "ninguém pediu" faria o
    // pedido sumir em silêncio — por isso o erro é checado e vira 500, nunca um
    // `update_requested: false` otimista.
    const { data: run, error: runLookupError } = await db
      .from("system_update_runs")
      .select("id, status, to_version")
      .eq("status", "dispatched")
      .order("dispatched_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (runLookupError) {
      logger.error("[system/agent] heartbeat não conseguiu achar o run pendente", {
        error: runLookupError.message,
      });
      return fail("internal_error", "Não consegui checar o pedido de atualização.", 500);
    }

    return ok({
      update_requested: Boolean(run),
      run_id: run?.id ?? null,
      // Vazio = sem alvo nomeado no run (rota anterior a #2757, ou run sem
      // `to_version`): o agente cai no de sempre, a última release publicada.
      to_version: run?.to_version ?? "",
    });
  }

  // ── A volta automática (#2757) ────────────────────────────────────────────
  // Ela não tem `run_id`: ninguém pediu pela tela, então não existe run em
  // `dispatched` para fechar. O recado VIRA uma linha de run já fechada, com o
  // mesmo vocabulário das outras (`failed_rolled_back` quando a volta
  // terminou, `failed` quando não — ver abaixo), porque é isso que a tela de
  // Atualização já sabe ler — e `requested_by` fica NULO, que é a marca de
  // "ninguém pediu isto" usada pela tela para dizer "sozinho".
  //
  // Antes do lookup de run pendente de propósito: esta mensagem não pergunta
  // nada, só conta um fato.
  if (payload.kind === "rollback") {
    const agora = new Date().toISOString();
    // O DESFECHO decide o status, e é o único lugar onde isso é decidido
    // (#3271). `failed_rolled_back` é a volta que TERMINOU: o `update.sh --to`
    // deu código 0, a versão anterior subiu, e a tela pode afirmar que é ela
    // que está no ar e dispensar o botão de voltar (que ali apontaria para a
    // versão que já roda). Quando a volta NÃO terminou, as duas frases deixam
    // de se sustentar — a linha vai como `failed`, o desfecho em que a tela
    // diz que não sabe o que está rodando e mantém a saída de um clique.
    //
    // `ok` ausente = agente anterior a este contrato (o app atualiza antes do
    // script do host — o mesmo bootstrap do `compare_failed` no heartbeat).
    // Sem o campo não há prova de que a volta terminou, e gravar
    // `failed_rolled_back` seria afirmar o que ninguém mediu: vale o lado
    // conservador, que erra para o de fazer conferir e não para o de
    // tranquilizar sem base.
    const voltouBem = payload.ok === true;
    const desfechoDaVolta = voltouBem ? "failed_rolled_back" : "failed";
    const { error } = await db.from("system_update_runs").insert({
      from_version: payload.returned_to,
      to_version: payload.failed_version,
      status: desfechoDaVolta,
      requested_by: null,
      dispatched_at: agora,
      finished_at: agora,
      log_tail: payload.reason,
    });
    if (error) {
      // Fatal para ESTA mensagem, e só para ela: sem a linha, a volta some do
      // painel e o agente não tem como saber (recebe 500 e anota no log dele).
      logger.error("[system/agent] a volta automática não foi registrada", {
        error: error.message,
      });
      return fail("internal_error", "Não consegui registrar a volta automática.", 500);
    }
    await audit({
      action: "system.update_finished",
      resourceType: "system_update_run",
      // Sem id: a linha não foi pedida por ninguém e o insert não a devolve.
      metadata: {
        status: desfechoDaVolta,
        volta_automatica: true,
        de: payload.failed_version,
        para: payload.returned_to,
      },
      actingAsPlatformAdmin: true,
    });
    return ok({ update_requested: false });
  }

  // Erro de leitura ≠ "não existe": sem checar, uma falha de banco viraria 404
  // e o agente trataria o run como inexistente — o mesmo defeito que reprovou
  // o lookup do heartbeat acima.
  const { data: run, error: runReadError } = await db
    .from("system_update_runs")
    .select("id, status")
    .eq("id", payload.run_id)
    .maybeSingle();

  if (runReadError) {
    logger.error("[system/agent] leitura do run falhou", {
      error: runReadError.message,
      runId: payload.run_id,
    });
    return fail("internal_error", "Não consegui ler a atualização.", 500);
  }

  if (!run) return fail("not_found", "Atualização não encontrada.", 404);

  if (payload.kind === "run_progress") {
    if (run.status !== "dispatched") {
      return fail("state_conflict", "Esta atualização já terminou.", 409);
    }
    const { error } = await db
      .from("system_update_runs")
      .update({ last_step: payload.step })
      .eq("id", payload.run_id);
    if (error) {
      logger.error("[system/agent] run_progress falhou", { error: error.message, runId: payload.run_id });
      return fail("internal_error", "Não consegui gravar o passo.", 500);
    }
    return ok({ update_requested: false, run_id: payload.run_id });
  }

  if (!canTransition(run.status as RunStatus, payload.status)) {
    return fail("invalid_state_transition", "Esta atualização já terminou.", 409);
  }

  // As três colunas da RODADA DO BANCO saem numa escrita PRÓPRIA e best-effort,
  // antes da que fecha o run: elas são cosméticas (viram uma frase na tela) e não
  // podem derrubar o desfecho. Na escrita única de antes, qualquer erro ali —
  // `42703` num banco anterior à migration da rodada, ou a CHECK recusando um
  // número — virava 500, o `post` do agente voltava vazio e o run ficava preso em
  // `dispatched` para sempre: o desfecho que ninguém detecta. Aqui, falha a
  // rodada e o run fecha; falha o run, o agente tenta de novo.
  await gravarRodadaDoBanco(db, payload);

  // A escrita que FECHA o run é a última, e é a única fatal. Se ela falhar, nada
  // mais acontece: sobra um run "dispatched" (estado real, o índice único da
  // migration 0090 impede ambiguidade) em vez de um pedido limpo com um run que
  // nunca fechou — essa ordem falha para o lado detectável e auto-curável (o
  // próximo heartbeat ainda vê o pedido e o run em aberto), nunca para o órfão
  // invisível.
  const { error: runUpdateError } = await db
    .from("system_update_runs")
    .update({
      status: payload.status,
      log_tail: payload.log_tail,
      finished_at: new Date().toISOString(),
    })
    .eq("id", payload.run_id);

  if (runUpdateError) {
    logger.error("[system/agent] run_result falhou ao finalizar o run", {
      error: runUpdateError.message,
      runId: payload.run_id,
    });
    return fail("internal_error", "Não consegui finalizar a atualização.", 500);
  }

  // Nada a "limpar" além disto: fechar o run É o fim do pedido, porque o run
  // é a única fonte da verdade sobre haver pedido (ver o heartbeat acima).

  await audit({
    action: "system.update_finished",
    resourceType: "system_update_run",
    resourceId: payload.run_id,
    metadata: { status: payload.status },
    actingAsPlatformAdmin: true,
  });

  return ok({ update_requested: false, run_id: payload.run_id });
}
