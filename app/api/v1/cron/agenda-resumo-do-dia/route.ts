/**
 * O RESUMO DAS 7H do aviso de agendamento no WhatsApp do dono (migration 0753).
 *
 * ═══ POR QUE DE DEZ EM DEZ MINUTOS, E NÃO UMA VEZ AO DIA ═══
 *
 * "7h" é o relógio de parede de CADA organização. A rodada varre só quem ligou
 * o aviso e, dentro de `aplicaResumoDoDia`, só age na organização cujo relógio
 * está entre 7h e 10h. A janela de três horas existe para o dia em que o
 * número está parado às 7h: o resumo sai assim que ele volta, e não amanhã. A
 * linha `unique (organization_id, dia)` garante que sai UMA vez.
 *
 * ═══ O MESMO ENVIO DO AVISO ═══
 *
 * As deps vêm de `criarDepsDoAvisoDeAgendamento` — o mesmo transporte, o mesmo
 * `pacing_ledger` (espaçamento e teto diário do número), a mesma recusa do
 * destino que é número da organização. Dois caminhos de envio divergiriam no
 * primeiro conserto.
 *
 * ═══ AUDITORIA SÓ QUANDO HOUVE EFEITO ═══
 *
 * Cada resumo que SAI (ou falha em definitivo) é auditado UMA vez, dentro do
 * motor, por `agenda.aviso_whatsapp_enviado`/`_falhou`. A rodada em si não
 * escreve linha: a batida das 3h da manhã que não tinha o que fazer não é
 * mutação, e a que enviou já deixou o rastro do envio — uma segunda linha por
 * rodada seria a mesma notícia duas vezes.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { aplicaResumoDoDia } from "@/lib/agenda/aviso-de-agendamento";
import { criarDepsDoAvisoDeAgendamento } from "@/lib/agenda/aviso-de-agendamento.handler";
import { ok, fail } from "@/lib/api/wrappers";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { logger } from "@/lib/logger";
import { idsDeOrgsParadas } from "@/lib/organizacao/operante";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/** Quantas organizações uma rodada atende. O resto fica para a de daqui a 10 min. */
const TETO_DE_ORGANIZACOES = 200;

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("config_aviso_de_agendamento")
    .select("organization_id")
    .eq("ligado", true)
    .limit(TETO_DE_ORGANIZACOES);
  if (error) {
    logger.error("[agenda-resumo-do-dia] configurações não lidas", { error: error.message, requestId });
    return fail("internal_error", "Falha ao buscar configurações.", 500, { requestId });
  }
  const ligadas = ((data ?? []) as Array<{ organization_id: string }>).map((l) => l.organization_id);
  if (ligadas.length === 0) return ok({ organizacoes: 0, enviados: 0, desfechos: {} }, { requestId });

  // Organização parada (suspensa, redigida, arquivada) não gasta nem fala.
  const paradas = new Set(await idsDeOrgsParadas(admin));
  const deps = await criarDepsDoAvisoDeAgendamento();

  let enviados = 0;
  const desfechos: Record<string, number> = {};
  const contar = (chave: string) => {
    desfechos[chave] = (desfechos[chave] ?? 0) + 1;
  };

  for (const orgId of ligadas) {
    if (paradas.has(orgId)) {
      contar("organizacao_parada");
      continue;
    }
    try {
      const desfecho = await aplicaResumoDoDia(deps, orgId);
      if (desfecho.status === "ok") enviados += 1;
      // Só o prefixo do detalhe: `ja_resolvido:enviado` e `ja_resolvido:falhou`
      // são o mesmo número na contagem da rodada.
      contar(`${desfecho.status}:${(desfecho.detail ?? "").split(":")[0]}`);
    } catch (err) {
      // Uma organização com defeito não pode derrubar o resumo das outras.
      contar("erro");
      logger.error("[agenda-resumo-do-dia] resumo falhou", {
        organization_id: orgId,
        error: err instanceof Error ? err.message : String(err),
        requestId,
      });
    }
  }

  return ok({ organizacoes: ligadas.length, enviados, desfechos }, { requestId });
}

export const GET = handle;
export const POST = handle;
