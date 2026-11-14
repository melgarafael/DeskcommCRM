/**
 * A PRÓXIMA OCORRÊNCIA DA TAREFA QUE SE REPETE (#4595) — a varredura.
 *
 * "Toda segunda às 9h, ligar para a carteira" é uma tarefa que hoje nasce à
 * mão toda semana. A regra mora em `crm_tasks.recurrence` (migration 9369) e a
 * conta inteira mora em `lib/tarefas/recorrencia.ts`; esta rota é só o relógio.
 *
 * ═══ POR QUE ELE NÃO É UMA CÓPIA DO `recurring-entries` ═══
 *
 * Aquele repete lançamento financeiro por dia do MÊS e grava em
 * `financial_entries`. O molde de lá que vale aqui é outro: a idempotência não
 * é desta rotina, é do índice único `(recurrence_source_id, due_date)`. Duas
 * rodadas no mesmo minuto chegam juntas no `on conflict do nothing` e só uma
 * grava; a segunda devolve `ja_existiam += 1`, que é o desfecho correto e não
 * um erro.
 *
 * ═══ O QUE ELE NÃO FAZ ═══
 *
 * Não cria tarefa para série desligada (`recurrence.ativa = false`), não toca
 * na série que já tem ocorrência futura, e não gera atrasadas em lote: uma
 * ocorrência por série por rodada. Cron parado por uma semana não despeja sete
 * tarefas atrasadas de uma vez — quem vê a lista não saberia o que fazer com
 * elas.
 *
 * A hora que aparece na tarefa é a hora de PAREDE da organização, e o instante
 * sai de `instanteDe` com o `organizations.timezone` de cada uma: rodar isto em
 * UTC marcaria a ligação das 9h para as 6h de Brasília.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { portaDaAplicacao } from "@/lib/db";
import { logger } from "@/lib/logger";
import { idsDeOrgsParadas } from "@/lib/organizacao/operante";
import { createAdminClient } from "@/lib/supabase/admin";
import { gerarOcorrencias } from "@/lib/tarefas/recorrencia";

export const dynamic = "force-dynamic";

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  try {
    // Organização parada (suspensa, redigida, arquivada) não gasta nem fala —
    // a série dela fica guardada e volta a gerar quando a org voltar. A lista
    // vem da MESMA régua dos outros crons, não de uma condição escrita aqui.
    const paradas = new Set(await idsDeOrgsParadas(createAdminClient()));
    const resultado = await gerarOcorrencias(portaDaAplicacao(), new Date(), paradas);
    if (resultado.criadas > 0) {
      logger.info("[task-recurrence] ocorrências geradas", {
        ...resultado,
        orgs_paradas: paradas.size,
        requestId,
      });
    }
    return ok(resultado, { requestId });
  } catch (erro) {
    // Falha de banco é 500 e aparece no log: a rodada seguinte tenta de novo, e
    // o índice único garante que tentar de novo não duplica o que já nasceu.
    logger.error("[task-recurrence] varredura falhou", {
      error: erro instanceof Error ? erro.message : String(erro),
      requestId,
    });
    return fail("internal_error", "Falha ao gerar as tarefas recorrentes.", 500, { requestId });
  }
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
