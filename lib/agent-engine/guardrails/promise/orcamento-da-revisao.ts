/** O chamador aplica o orçamento nativo antes de permitir a consulta ao JEV. */
import type pg from "pg";
import { aplicarOrcamento, type LlmEdgeConfig } from "../../edge/llm/run-model-call";
import { resolveOrgLlmBudget } from "../../edge/llm/credentials";
import type { Logger } from "../../obs/logger";
import { chaveDeOrcamentoDaInstalacao } from "@/lib/instalacao/comportamento";
import { MODELO_DO_JEV } from "@/lib/ai/decisao/cliente";

export async function conferirOrcamentoDaRevisao(
  pool: pg.Pool, cfg: LlmEdgeConfig,
  ids: { tenantId: string; leadId?: string | null; jobId?: string }, log: Logger,
): Promise<void> {
  const b = await resolveOrgLlmBudget(pool, ids.tenantId);
  await aplicarOrcamento({
    db: pool, organizationId: ids.tenantId,
    orcamentoDaConfig: b.orcamento, orcamentoIndisponivelPorque: b.orcamentoIndisponivelPorque,
    chave: chaveDeOrcamentoDaInstalacao(cfg.budgetEnforcement ?? "on"),
    origemDaChave: "credencial_da_organizacao", purpose: "promise_semantic",
    provider: "typesafe", model: `typesafe/${MODELO_DO_JEV}`, origem: "jev",
    input: ids, log,
  });
}
