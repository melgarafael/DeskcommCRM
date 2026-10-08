/**
 * Começa um run (spec §4.3): chamado pelo callback OAuth (`conexao`, força),
 * pela reconciliação e pelo botão "Sincronizar agora".
 */
import type { OrigemDoRun } from "./constantes";
import type { DepsDoSync } from "./deps";
import { primeiroPasso } from "./janelas";

export type ResultadoDoInicio =
  | { ok: true; runId: string }
  | { ok: false; motivo: "nao_conectada" | "desautorizada" | "sync_em_andamento" | "falha_ao_iniciar" };

export async function iniciarSincronizacao(deps: DepsDoSync, orgId: string, origem: OrigemDoRun): Promise<ResultadoDoInicio> {
  const integ = await deps.carregarIntegracao(orgId);
  if (!integ || integ.status === "disconnected") return { ok: false, motivo: "nao_conectada" };
  if (integ.status !== "healthy" && origem !== "conexao") return { ok: false, motivo: "desautorizada" };

  const estado = await deps.lerEstado(orgId);
  const passo = primeiroPasso({ runId: deps.novoRunId(), cursor: estado?.cursor_updated_at ?? null, agora: deps.agora() });
  const reservado = await deps.reservarRun(orgId, { passo, origem, agora: deps.agora(), forcar: origem === "conexao" });
  if (!reservado) return { ok: false, motivo: "sync_em_andamento" };

  try {
    await deps.emitirPasso(orgId, integ.id, passo);
  } catch {
    await deps.liberarRun(orgId, passo.run_id);
    return { ok: false, motivo: "falha_ao_iniciar" };
  }
  return { ok: true, runId: passo.run_id };
}
