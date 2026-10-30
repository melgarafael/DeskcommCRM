/**
 * GET/POST /api/v1/cron/followup-flow-worker — Onda 4 (Task 4.2) + Onda 8
 * (Task 8.1, gatilho de silêncio).
 *
 * Drena os enrollments due de `followup_enrollments` via `runFollowupTick`
 * (lib/followup/engine.ts) — o motor único de relógio do sistema de
 * follow-up. Trigger Postgres NUNCA faz HTTP; este cron TS é quem consome via
 * admin client, no mesmo contrato dos demais crons.
 *
 * Depois do tick, `runSilenceSweep` (lib/followup/silence-sweep.ts) NO MESMO
 * tick — gatilho TIME-DRIVEN (varredura periódica, não event-driven): acha
 * pointers `trigger_config.kind='silence'` ativos, decide o agente pelo grafo
 * (`decidirAgenteDoEnrollmentAutomatico`: texto fixo segue sem agente; nó de
 * IA exige agente publicado armando o pointer), acha contatos silenciosos e
 * cria enrollment. Falha do sweep NUNCA aborta a resposta do tick (try/catch
 * isolado, só loga) — o cron sempre devolve o resultado de `runFollowupTick`.
 *
 * No fim, drena texto fixo pendente (`enviarTextoFixoPendente`) — o mesmo
 * atalho do relógio HTTP. Onde não há `agent-worker` (instalação sem o
 * contêiner `worker`), sem isto o job `followup_turn` fica `pending` e o
 * no_reply nunca vira mensagem. O ledger (job_id, seq) impede envio em dobro no
 * self-host, onde o worker também consome a fila.
 *
 * Auth: Bearer INTERNAL_CRON_SECRET|INTERNAL_SECRET, fail-closed. Audit
 * agregada por tick (`followup.worker_run` + `followup.silence_sweep_run`),
 * sem organization_id (roda pra todas as orgs).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { invalidarRecursosLigados, recursoLigado } from "@/lib/cron/recursos-ligados";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { createSupabaseAdminClient, runFollowupTick, type FollowupJobRequest, type TickSummary } from "@/lib/followup/engine";
import { createSupabaseFollowupGateDb } from "@/lib/followup/agent-followup-gate";
import { enviarTextoFixoPendente } from "@/lib/followup/enviar-texto-fixo";
import { encerrarRoteirosVencidos } from "@/lib/followup/atendimento";
import { createSupabaseSilenceSweepDb, runSilenceSweep } from "@/lib/followup/silence-sweep";
import { autorizaCron } from "@/lib/auth/cron-auth";

export const dynamic = "force-dynamic";

/** Insere o job followup_turn na fila existente (migration 0050) — consumido
 *  pelo handler já pronto em lib/agent-engine/agent/followup-turn.ts. */
async function enqueueJob(job: FollowupJobRequest): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.from("job_queue").insert({
    organization_id: job.organization_id,
    contact_id: job.contact_id,
    kind: "followup_turn",
    payload: job.payload,
  });
  if (error) throw new Error(error.message);
}

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  const admin = createAdminClient();
  const deps = {
    db: createSupabaseAdminClient(admin),
    clock: () => new Date(),
    enqueueJob,
  };

  // ─── O QUE ESTÁ LIGADO NESTA INSTALAÇÃO (#3694) ───────────────────────────
  //
  // Três das oito consultas vazias medidas na issue moram nesta rota: o claim
  // do follow-up (1,0/min, 120/120 vazias), os pointers do silêncio (1,0/min) e
  // a fila do follow-up (1,0/min). As três saem de UMA leitura compartilhada —
  // as chamadas se coalescem numa só ida ao banco por janela de 45 s, a mesma
  // que os outros crons de minuto usam.
  //
  // O que NÃO é gated aqui, de propósito: a varredura de confirmação de
  // presença (RPC, mutação de agenda) e `encerrarRoteirosVencidos` (RPC, muda
  // estado de roteiro). As duas MUTAM mesmo sem nada vencido no follow-up, não
  // estavam na medição da issue e ficam fora — rodada que fecha roteiro vencido
  // é efeito, não consulta vazia.
  const [followupLigado, silencioLigado, filaLigada] = await Promise.all([
    recursoLigado(admin, "followup"),
    recursoLigado(admin, "followup_silencio"),
    recursoLigado(admin, "fila_followup"),
  ]);

  // A varredura de confirmação de presença pega carona neste cron, mas é OUTRO
  // assunto: antes, um erro só nela devolvia 500 ANTES do motor rodar, e o
  // follow-up de todas as orgs parava junto com a agenda. Agora a falha fica
  // isolada aqui (log + Sentry + trilha) e volta na resposta em
  // `confirmation_sweep`, sem esconder — mas sem derrubar o tick.
  const confirmationSweep = await varrerConfirmacoesDePresenca(admin, requestId);

  // Tick que não chegou a rodar é indistinguível, na resposta, de um tick sem
  // nada vencido — a não ser pelo `recursos` no fim do corpo, que diz por quê.
  let summary: TickSummary = { claimed: 0, advanced: 0, scheduled: 0, failed: 0, dead: 0 };
  if (followupLigado) {
    try {
      summary = await runFollowupTick(deps);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logger.error("[followup-flow-worker.cron] runFollowupTick threw", { error: detail, requestId });
      return fail("internal_error", detail, 500, { requestId });
    }
  }

  // ─── QUEM CRIA TRABALHO AVISA (#3694) ──────────────────────────────────────
  //
  // A leitura dos recursos vale 45 s. Para o que NASCE FORA deste processo
  // (gatilho no banco, `agent-worker` em outro contêiner) o atraso é o preço
  // declarado do cache — no máximo um tique, porque o cron é de minuto. Para o
  // que nasce AQUI, não: esta mesma batida inscreve contatos (varredura de
  // silêncio) e enfileira `followup_turn` (tick), e a batida seguinte tem de
  // enxergar isso na hora. Sem a invalidação, o cache responde o retrato de
  // ANTES do trabalho que esta rota acabou de criar — e o motor fica parado o
  // resto da janela, que é exatamente "sair cedo atrasando trabalho real".
  //
  // Medido no e2e `followup-journey.spec.ts`: o enrollment nascia na varredura e
  // os POSTs seguintes (mais rápidos que os 45 s) liam `followup: false` do
  // cache e devolviam 200 sem reclamar a inscrição.
  let houveMovimento = Boolean(summary.claimed || summary.advanced || summary.scheduled);

  // Só audita tick que MEXEU em alguma coisa. Auditar toda batida enchia o
  // api_audit_log — que é append-only e tem retenção de 5 anos — de linhas
  // vazias: numa instalação parada, medido nesta VPS, 95% das entradas eram
  // heartbeat de cron (1.175 de 1.236 em ~9h), afogando as ações reais na tela
  // de auditoria. Liveness de worker é assunto de log/monitoramento, não de
  // trilha de auditoria.
  //
  // `claim_falhou` entra na condição porque é o ÚNICO caso em que todos os
  // contadores são zero e ainda assim algo aconteceu: o claim não chegou ao
  // banco. Sem esta cláusula o tick que falhou é idêntico, na trilha, ao tick de
  // uma instalação sem nada a fazer.
  //
  // O emissor NUNCA foi o buraco: `claim_falhou` e o `logger.error` existem em
  // `runFollowupTick` desde f66f0ddb, com teste. O que faltava era o outro lado
  // — anti-pattern 3 do CLAUDE.md, evento sem consumer: o campo criado para
  // separar "o banco não respondeu" de "não havia nada a fazer" era emitido e
  // ninguém o lia. Quem vier depois precisa saber onde estava o defeito, senão
  // vai procurar no lugar que já estava certo.
  if (
    summary.claim_falhou ||
    summary.claimed ||
    summary.advanced ||
    summary.scheduled ||
    summary.failed ||
    summary.dead
  ) {
    void audit({
      action: "followup.worker_run",
      organizationId: null,
      bypassedRls: true,
      metadata: { ...summary },
      requestId,
    });
  }

  if (silencioLigado) {
    try {
      const sweepSummary = await runSilenceSweep({
        db: createSupabaseSilenceSweepDb(admin),
        gateDb: createSupabaseFollowupGateDb(admin),
        clock: () => new Date(),
      });
      // `skipped_cooldown` NÃO entra aqui de propósito (revisão do PR): por
      // definição ele é "nada aconteceu" — incluí-lo faria o audit log escrever
      // uma linha por tick (1×/min) durante toda a janela de cooldown de cada
      // enrollment concluído, o mesmo anti-padrão que este arquivo já existe
      // para evitar (ver "Audit log" no CLAUDE.md, o histórico do
      // routing-worker/attendant-heartbeat).
      if (sweepSummary.enrolled) houveMovimento = true;
      if (sweepSummary.enrolled || sweepSummary.pointers_gated_out || sweepSummary.skipped_existing) {
        void audit({
          action: "followup.silence_sweep_run",
          organizationId: null,
          bypassedRls: true,
          metadata: { ...sweepSummary },
          requestId,
        });
      }
    } catch (err) {
      // Sweep falhando NUNCA aborta o tick — a resposta abaixo já reflete o
      // resultado de runFollowupTick, que rodou (e foi auditado) antes disto.
      const detail = err instanceof Error ? err.message : String(err);
      logger.error("[followup-flow-worker.cron] runSilenceSweep threw", { error: detail, requestId });
    }
  }

  // Roteiro de atendimento com o prazo vencido (0397). Audita só quando houve
  // efeito — rodada que não encerrou nada não é mutação.
  try {
    const expirados = await encerrarRoteirosVencidos(admin);
    if (expirados > 0) {
      void audit({
        action: "followup.roteiros_expirados",
        organizationId: null,
        bypassedRls: true,
        metadata: { expirados },
        requestId,
      });
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("[followup-flow-worker.cron] encerrarRoteirosVencidos threw", { error: detail, requestId });
  }

  // ponytail: instalação sem `agent-worker` (relógio HTTP, cron puro) não tem
  // quem consuma a fila. Sem este dreno o no_reply avança o grafo e a mensagem
  // seguinte fica pending. Teto: jobs sem fixed_body (mode ai_message) continuam
  // precisando do worker.
  if (filaLigada) {
    try {
      await enviarTextoFixoPendente(admin);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logger.error("[followup-flow-worker.cron] enviarTextoFixoPendente threw", { error: detail, requestId });
    }
  }

  // A invalidação vem DEPOIS do dreno de propósito: a batida seguinte relê os
  // recursos (esta criou `followup_turn`, que liga `fila_followup`) e já entra
  // no tick sem esperar a janela vencer.
  if (houveMovimento) invalidarRecursosLigados();

  return ok(
    {
      ...summary,
      confirmation_sweep: confirmationSweep,
      // Diz, sem ambiguidade, se a rodada rodou: tick de minuto com três `false`
      // aqui é "nada ligado nesta instalação", não "o motor falhou calado".
      recursos: { followup: followupLigado, followup_silencio: silencioLigado, fila_followup: filaLigada },
    },
    { requestId },
  );
}

/**
 * Resultado da varredura de confirmação de presença, devolvido na resposta do
 * tick. `ok: false` é a falha PARCIAL: o motor de follow-up rodou, a agenda não.
 */
type ResultadoDaVarreduraDeConfirmacao = { ok: true; avisos: number } | { ok: false; erro: string };

/**
 * Roda `fn_appointment_confirmation_sweep` sem nunca lançar. Cobre os dois
 * jeitos de falhar: `error` devolvido pelo PostgREST e exceção do próprio
 * client (rede, fetch abortado) — os dois teriam o mesmo efeito de parar o tick.
 *
 * A falha AUDITA (mesma action, `falhou: true`), como o `claim_falhou` do
 * motor: senão a rodada que não conseguiu varrer fica idêntica, na trilha, à
 * rodada que não tinha aviso a abrir.
 */
async function varrerConfirmacoesDePresenca(
  admin: ReturnType<typeof createAdminClient>,
  requestId: string,
): Promise<ResultadoDaVarreduraDeConfirmacao> {
  let resultado: ResultadoDaVarreduraDeConfirmacao;
  let causa: unknown;
  try {
    const confirmation = await admin.rpc("fn_appointment_confirmation_sweep", {});
    if (confirmation.error) {
      causa = new Error(confirmation.error.message);
      resultado = { ok: false, erro: confirmation.error.message };
    } else {
      resultado = { ok: true, avisos: Number(confirmation.data) || 0 };
    }
  } catch (err) {
    causa = err;
    resultado = { ok: false, erro: err instanceof Error ? err.message : String(err) };
  }

  if (resultado.ok && resultado.avisos > 0) {
    void audit({
      action: "agenda.confirmation_sweep_run",
      organizationId: null,
      bypassedRls: true,
      requestId,
      metadata: { avisos: resultado.avisos },
    });
  }
  if (!resultado.ok) {
    logger.error("[followup-flow-worker.cron] fn_appointment_confirmation_sweep falhou", {
      error: resultado.erro,
      requestId,
    });
    avisaSentry(causa, requestId);
    void audit({
      action: "agenda.confirmation_sweep_run",
      organizationId: null,
      bypassedRls: true,
      requestId,
      metadata: { falhou: true, erro: resultado.erro },
    });
  }
  return resultado;
}

/**
 * Sentry por import DINÂMICO com `.catch`, como em
 * `app/api/v1/cron/webhook-log-retention/route.ts`: sem SENTRY_DSN a import
 * pode nem carregar, e o aviso não pode virar a segunda falha da rodada.
 */
function avisaSentry(err: unknown, requestId: string): void {
  const detalhe = err instanceof Error ? err.message : String(err);
  void import("@sentry/nextjs")
    .then((Sentry) => {
      Sentry.captureException(err instanceof Error ? err : new Error(detalhe), {
        level: "error",
        tags: { subsystem: "agenda", varredura: "confirmation_sweep" },
        extra: { request_id: requestId },
      });
    })
    .catch(() => {
      /* sem Sentry configurado: o logger.error e a linha de trilha bastam */
    });
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
