/**
 * `integration_sync_state` (migration 0611). Toda escrita filtra
 * `organization_id` + `provider` + `resource`, e as de um run também `run_id`:
 * um evento de run antigo nunca escreve sobre o run novo.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { PROVEDOR, TRAVA_MS, type OrigemDoRun, type PassoDoSync } from "./constantes";

export interface EstadoDoSync {
  organization_id: string;
  status: "idle" | "running" | "error";
  run_id: string | null;
  run_origem: OrigemDoRun | null;
  trava_ate: string | null;
  cursor_updated_at: string | null;
  janela_atual_ini: string | null;
  janela_atual_fim: string | null;
  alvo_fim: string | null;
  pedidos_gravados: number;
  pedidos_com_erro: number;
  ultimo_erro: string | null;
  ultimo_run_fim: string | null;
}

const COLUNAS =
  "organization_id, status, run_id, run_origem, trava_ate, cursor_updated_at, janela_atual_ini, janela_atual_fim, alvo_fim, pedidos_gravados, pedidos_com_erro, ultimo_erro, ultimo_run_fim";
const TABELA = "integration_sync_state";
const RECURSO = "orders";

export async function lerEstado(admin: SupabaseClient, orgId: string): Promise<EstadoDoSync | null> {
  const { data, error } = await admin
    .from(TABELA)
    .select(COLUNAS)
    .eq("organization_id", orgId)
    .eq("provider", PROVEDOR)
    .eq("resource", RECURSO)
    .maybeSingle();
  if (error) throw new Error(`sync_state_leitura:${error.message}`);
  return (data as EstadoDoSync | null) ?? null;
}

/**
 * Um UPDATE só, com a condição de largada no WHERE (spec §4.3): idle, run morto
 * (trava vencida) ou erro que não seja de autorização. `forcar` (reconexão)
 * ignora a condição: a conexão nova substitui qualquer run.
 */
export async function reservarRun(
  admin: SupabaseClient,
  orgId: string,
  args: { passo: PassoDoSync; origem: OrigemDoRun; agora: Date; forcar: boolean },
): Promise<boolean> {
  const { error: erroSemente } = await admin
    .from("integration_sync_state")
    .upsert(
      { organization_id: orgId, provider: PROVEDOR, resource: RECURSO },
      { onConflict: "organization_id,provider,resource", ignoreDuplicates: true },
    );
  if (erroSemente) throw new Error(`sync_state_semente:${erroSemente.message}`);

  const agoraIso = args.agora.toISOString();
  let q = admin
    .from(TABELA)
    .update({
      status: "running",
      run_id: args.passo.run_id,
      run_origem: args.origem,
      trava_ate: new Date(args.agora.getTime() + TRAVA_MS).toISOString(),
      alvo_fim: args.passo.alvo_fim,
      janela_atual_ini: args.passo.janela_ini,
      janela_atual_fim: args.passo.janela_fim,
      pedidos_gravados: 0,
      pedidos_com_erro: 0,
      ultimo_erro: null,
    })
    .eq("organization_id", orgId)
    .eq("provider", PROVEDOR)
    .eq("resource", RECURSO);
  if (!args.forcar) {
    q = q.or(
      // Valor entre aspas: o ISO tem `.` e `:`, que o parser do PostgREST reserva.
      `status.eq.idle,trava_ate.lt."${agoraIso}",and(status.eq.error,or(ultimo_erro.is.null,ultimo_erro.neq.auth))`,
    );
  }
  const { data, error } = await q.select("run_id");
  if (error) throw new Error(`sync_state_reserva:${error.message}`);
  return (data ?? []).length > 0;
}

export async function registrarPagina(
  admin: SupabaseClient,
  estado: EstadoDoSync,
  args: { gravados: number; comErro: number; ultimoErro: string | null; passo: PassoDoSync; agora: Date },
): Promise<void> {
  const { error } = await admin
    .from(TABELA)
    .update({
      pedidos_gravados: estado.pedidos_gravados + args.gravados,
      pedidos_com_erro: estado.pedidos_com_erro + args.comErro,
      ultimo_erro: args.ultimoErro ?? estado.ultimo_erro,
      janela_atual_ini: args.passo.janela_ini,
      janela_atual_fim: args.passo.janela_fim,
      trava_ate: new Date(args.agora.getTime() + TRAVA_MS).toISOString(),
    })
    .eq("organization_id", estado.organization_id)
    .eq("provider", PROVEDOR)
    .eq("resource", RECURSO)
    .eq("run_id", args.passo.run_id);
  if (error) throw new Error(`sync_state_pagina:${error.message}`);
}

export async function fecharRun(admin: SupabaseClient, estado: EstadoDoSync, agora: Date): Promise<EstadoDoSync | null> {
  if (!estado.run_id) return null;
  const { data, error } = await admin
    .from(TABELA)
    .update({
      status: "idle",
      run_id: null,
      trava_ate: null,
      cursor_updated_at: estado.alvo_fim,
      ultimo_run_fim: agora.toISOString(),
    })
    .eq("organization_id", estado.organization_id)
    .eq("provider", PROVEDOR)
    .eq("resource", RECURSO)
    .eq("run_id", estado.run_id)
    .select(COLUNAS)
    .maybeSingle();
  if (error) throw new Error(`sync_state_fim:${error.message}`);
  if (!data) return null;
  const { error: erroSync } = await admin
    .from("tenant_integrations")
    .update({ last_sync_at: agora.toISOString() })
    .eq("organization_id", estado.organization_id)
    .eq("provider", PROVEDOR);
  if (erroSync) throw new Error(`sync_state_last_sync:${erroSync.message}`);
  return data as EstadoDoSync;
}

export async function liberarRun(admin: SupabaseClient, orgId: string, runId: string | null): Promise<void> {
  let q = admin
    .from(TABELA)
    .update({ status: "idle", run_id: null, trava_ate: null })
    .eq("organization_id", orgId)
    .eq("provider", PROVEDOR)
    .eq("resource", RECURSO);
  if (runId) q = q.eq("run_id", runId);
  const { error } = await q;
  if (error) throw new Error(`sync_state_liberar:${error.message}`);
}
