/**
 * Gera os lançamentos dos moldes recorrentes.
 *
 * Roda uma vez por dia. Para cada molde ativo, calcula a competência do mês
 * corrente e insere a linha PENDENTE se ela ainda não existir.
 *
 * ⚠️ A IDEMPOTÊNCIA NÃO É DESTA ROTINA. Ela é do índice único
 * `(recurring_entry_id, entry_date)`. Aqui o erro `23505` é tratado como
 * "já existia", que é o desfecho correto: duas execuções simultâneas passam
 * pela mesma checagem e só uma grava.
 *
 * ⚠️ NASCE PENDENTE, NUNCA PAGA. O sistema sabe que a conta vence; ele não sabe
 * se alguém pagou. Marcar como paga automaticamente encheria o caixa de dinheiro
 * que não saiu, e o saldo do relatório passaria a mentir todo dia 5.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/**
 * A data da competência deste mês para um molde.
 *
 * ⚠️ ONZE MESES DO ANO NÃO TÊM TODOS OS DIAS. Um molde de dia 31 em fevereiro
 * não pode ser pulado (deixaria de cobrar o aluguel) nem empurrado para março
 * (mudaria a competência): ele cai no último dia do mês.
 *
 * Pura e exportada porque é a regra inteira, e esperar fevereiro para testá-la
 * seria absurdo.
 */
export function competenciaDoMes(ano: number, mes: number, diaDoMes: number): string {
  // Dia 0 do mês seguinte é o último dia deste. `Date.UTC` porque a competência
  // é uma data civil, não um instante: usar o fuso local do servidor faria a
  // mesma instalação gerar dias diferentes conforme onde ela roda.
  const ultimoDia = new Date(Date.UTC(ano, mes, 0)).getUTCDate();
  const dia = Math.min(diaDoMes, ultimoDia);
  return `${ano}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
}

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  const admin = createAdminClient();
  const agora = new Date();
  const ano = agora.getUTCFullYear();
  const mes = agora.getUTCMonth() + 1;

  const { data: moldes, error } = await admin
    .from("recurring_entries")
    .select(
      "id, organization_id, account_id, account_plan_id, direction, amount_cents, currency, name, day_of_month",
    )
    .eq("is_active", true);

  if (error) {
    logger.error("[recurring-entries] consulta falhou", { error: error.message, requestId });
    return fail("internal_error", "Falha ao buscar recorrências.", 500, { requestId });
  }

  let gerados = 0;
  let jaExistiam = 0;
  let falharam = 0;

  for (const molde of moldes ?? []) {
    const competencia = competenciaDoMes(ano, mes, molde.day_of_month as number);

    // Só gera quando a data já chegou. Sem isto, no dia 1 nasceriam as doze
    // contas do mês inteiro e a tela de pendências viraria uma lista de coisas
    // que ainda não venceram.
    if (competencia > agora.toISOString().slice(0, 10)) continue;

    const { error: erroInsert } = await admin.from("financial_entries").insert({
      organization_id: molde.organization_id,
      account_id: molde.account_id,
      account_plan_id: molde.account_plan_id,
      direction: molde.direction,
      amount_cents: molde.amount_cents,
      currency: molde.currency,
      description: molde.name,
      entry_date: competencia,
      status: "pending",
      origin: "recurring",
      recurring_entry_id: molde.id,
    });

    if (!erroInsert) {
      gerados += 1;
      continue;
    }
    // 23505 = o índice único pegou. É o desfecho esperado em toda rodada depois
    // da primeira do mês, e não é erro.
    if (erroInsert.code === "23505") {
      jaExistiam += 1;
      continue;
    }
    falharam += 1;
    logger.error("[recurring-entries] insert falhou", {
      recurring_entry_id: molde.id,
      organization_id: molde.organization_id,
      error: erroInsert.message,
      requestId,
    });
  }

  // Rodada que não gerou nada NÃO é mutação, e não audita — a lei está no
  // CLAUDE.md §Audit log, e `tests/unit/cron-audita-so-quando-ha-efeito.test.ts`
  // varre o AST de toda rota deste diretório atrás de `audit` incondicional.
  if (gerados > 0) {
    await audit({
      action: "financeiro.recorrencia_gerada",
      resourceType: "financial_entry",
      requestId,
      metadata: { gerados, ja_existiam: jaExistiam, falharam },
    });
  }

  return ok(
    { moldes: (moldes ?? []).length, gerados, ja_existiam: jaExistiam, falharam },
    { requestId },
  );
}

export const GET = handle;
export const POST = handle;
