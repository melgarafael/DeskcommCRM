/**
 * A leitura da ocupação do Outlook: renova o acesso, atualiza a lista de agendas
 * e troca o espelho de cada agenda que a pessoa marcou.
 *
 * Releitura COMPLETA da janela, sem cursor incremental: a troca é atômica no
 * banco, e uma leitura que falha no meio não grava nada — o espelho anterior
 * continua bloqueando e a tela avisa que a cobertura está atrasada.
 *
 * Roda com service role: TODA consulta filtra `organization_id`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import { decryptWebhookSecret, encryptWebhookSecret } from "@/lib/webhooks/secrets";

import type { AppDaMicrosoft } from "./config";
import { EventoIlegivel, ocupacaoDoEvento } from "./evento";
import { ErroDoGraph, graphDaMicrosoft, type AgendaDaMicrosoft } from "./graph";
import { renovar } from "./oauth";

/** A mesma janela que a ocupação das outras agendas cobre. */
export const DIAS_PARA_TRAS = 1;
export const DIAS_PARA_FRENTE = 90;
const FOLGA_DE_RENOVACAO_MS = 5 * 60_000;
const VALIDADE_DO_CATALOGO_MS = 60 * 60_000;
const RECUO_MS = 15 * 60_000;
const DIA_MS = 86_400_000;

export interface ConexaoDaMicrosoft {
  id: string;
  organization_id: string;
  user_id: string;
  oauth_access_token_encrypted: string | null;
  oauth_refresh_token_encrypted: string | null;
  token_expires_at: string | null;
  catalog_retry_at: string | null;
}

export const COLUNAS_DA_CONEXAO =
  "id,organization_id,user_id,oauth_access_token_encrypted,oauth_refresh_token_encrypted,token_expires_at,catalog_retry_at";

interface Dependencias {
  agora?: Date;
  buscar?: typeof fetch;
}

class PrecisaReconectar extends Error {}

async function marcarConexao(
  db: SupabaseClient,
  conexao: ConexaoDaMicrosoft,
  valores: Record<string, unknown>,
) {
  const { error } = await db
    .from("calendar_connections")
    .update(valores)
    .eq("organization_id", conexao.organization_id)
    .eq("id", conexao.id)
    // Quem desconectou enquanto a rodada corria continua desconectado.
    .neq("status", "disconnected");
  if (error) throw error;
}

async function acessoValido(
  db: SupabaseClient,
  app: AppDaMicrosoft,
  conexao: ConexaoDaMicrosoft,
  { agora = new Date(), buscar }: Dependencias,
): Promise<string> {
  const vence = conexao.token_expires_at ? Date.parse(conexao.token_expires_at) : 0;
  if (conexao.oauth_access_token_encrypted && vence - agora.getTime() > FOLGA_DE_RENOVACAO_MS) {
    const atual = await decryptWebhookSecret(db, conexao.oauth_access_token_encrypted);
    if (atual) return atual;
  }
  if (!conexao.oauth_refresh_token_encrypted) throw new PrecisaReconectar();
  const refresh = await decryptWebhookSecret(db, conexao.oauth_refresh_token_encrypted);
  // Decifra que falha é a chave da instalação, não a autorização da pessoa.
  if (!refresh) throw new Error("cifra_indisponivel");
  const leitura = await renovar(app, refresh, { agora, buscar });
  if (!leitura.ok) {
    if (leitura.motivo === "reautenticar") throw new PrecisaReconectar();
    throw new Error(leitura.motivo);
  }
  const access = await encryptWebhookSecret(db, leitura.token.accessToken);
  const novoRefresh = leitura.token.refreshToken
    ? await encryptWebhookSecret(db, leitura.token.refreshToken)
    : null;
  if (!access || (leitura.token.refreshToken && !novoRefresh)) throw new Error("cifra_indisponivel");
  await marcarConexao(db, conexao, {
    oauth_access_token_encrypted: access,
    ...(novoRefresh ? { oauth_refresh_token_encrypted: novoRefresh } : {}),
    token_expires_at: leitura.token.expiraEm,
  });
  return leitura.token.accessToken;
}

/**
 * Grava a lista de agendas. A escolha da pessoa nunca é reescrita: só a agenda
 * NOVA ganha o padrão (a principal conta, as outras não).
 *
 * `access_role = reader` sempre — é o que impede uma agenda do Outlook de virar
 * destino de publicação.
 */
export async function atualizarAgendas(
  db: SupabaseClient,
  org: string,
  conexaoId: string,
  agendas: readonly AgendaDaMicrosoft[],
  agora: Date = new Date(),
) {
  const { data, error } = await db
    .from("calendar_connection_calendars")
    .select("id,external_calendar_id")
    .eq("organization_id", org)
    .eq("connection_id", conexaoId);
  if (error) throw error;
  const conhecidas = new Map(
    ((data ?? []) as { id: string; external_calendar_id: string }[]).map((l) => [
      l.external_calendar_id,
      l.id,
    ]),
  );
  const comum = { access_role: "reader", catalog_checked_at: agora.toISOString() };
  for (const agenda of agendas) {
    const id = conhecidas.get(agenda.id);
    const valores = { ...comum, name: agenda.nome, is_primary: agenda.principal, available: true };
    const escrita = id
      ? await db
          .from("calendar_connection_calendars")
          .update(valores)
          .eq("organization_id", org)
          .eq("id", id)
      : await db.from("calendar_connection_calendars").insert({
          ...valores,
          organization_id: org,
          connection_id: conexaoId,
          external_calendar_id: agenda.id,
          counts_for_conflicts: agenda.principal,
          is_destination: false,
        });
    if (escrita.error) throw escrita.error;
  }
  const presentes = new Set(agendas.map((a) => a.id));
  for (const [externo, id] of conhecidas) {
    if (presentes.has(externo)) continue;
    // A agenda deixou de existir lá: sai da escolha e o bloqueio dela sai junto.
    const apagados = await db
      .from("calendar_external_events")
      .delete()
      .eq("organization_id", org)
      .eq("connection_id", conexaoId)
      .eq("external_calendar_id", externo);
    if (apagados.error) throw apagados.error;
    const removida = await db
      .from("calendar_connection_calendars")
      .update({ ...comum, available: false, counts_for_conflicts: false })
      .eq("organization_id", org)
      .eq("id", id);
    if (removida.error) throw removida.error;
  }
}

function frase(erro: unknown): string {
  if (erro instanceof EventoIlegivel) return erro.message;
  if (erro instanceof ErroDoGraph) {
    if (erro.status === 429) return "O Outlook pediu para aguardar. A leitura volta sozinha.";
    if (erro.status === 401 || erro.status === 403)
      return "O Outlook recusou o acesso à agenda. Reconecte a conta.";
  }
  return "Não foi possível atualizar a agenda do Outlook. Tentaremos de novo.";
}

export type ResultadoDaSincronia = { lidas: number; falhas: number; reconectar: boolean };

/** Uma conexão. `forcar` ignora os relógios (usado logo depois de conectar). Nunca lança. */
export async function sincronizarConexao(
  db: SupabaseClient,
  app: AppDaMicrosoft,
  conexao: ConexaoDaMicrosoft,
  deps: Dependencias & { forcar?: boolean } = {},
): Promise<ResultadoDaSincronia> {
  const agora = deps.agora ?? new Date();
  const org = conexao.organization_id;
  const resultado: ResultadoDaSincronia = { lidas: 0, falhas: 0, reconectar: false };
  try {
    const { data: catalogo, error: erroDoCatalogo } = await db
      .from("calendar_connection_calendars")
      .select("catalog_checked_at,sync_next_attempt_at,available,counts_for_conflicts")
      .eq("organization_id", org)
      .eq("connection_id", conexao.id);
    if (erroDoCatalogo) throw erroDoCatalogo;
    const linhas = (catalogo ?? []) as {
      catalog_checked_at: string | null;
      sync_next_attempt_at: string;
      available: boolean;
      counts_for_conflicts: boolean;
    }[];
    const ultimo = Math.max(0, ...linhas.map((l) => Date.parse(l.catalog_checked_at ?? "") || 0));
    const catalogoVencido = deps.forcar || agora.getTime() - ultimo > VALIDADE_DO_CATALOGO_MS;
    const haVencida = linhas.some(
      (l) => l.available && l.counts_for_conflicts && Date.parse(l.sync_next_attempt_at) <= agora.getTime(),
    );
    // Recuo depois de falha de conta: sem ele, um 429 seria repetido a cada minuto.
    if (!deps.forcar && conexao.catalog_retry_at && Date.parse(conexao.catalog_retry_at) > agora.getTime())
      return resultado;
    if (!catalogoVencido && !haVencida) return resultado;

    const graph = graphDaMicrosoft(await acessoValido(db, app, conexao, deps), deps.buscar);
    if (catalogoVencido) await atualizarAgendas(db, org, conexao.id, await graph.agendas(), agora);

    let consulta = db
      .from("calendar_connection_calendars")
      .select("id,external_calendar_id")
      .eq("organization_id", org)
      .eq("connection_id", conexao.id)
      .eq("available", true)
      .eq("counts_for_conflicts", true);
    if (!deps.forcar) consulta = consulta.lte("sync_next_attempt_at", agora.toISOString());
    const { data: agendas, error: erroDasAgendas } = await consulta;
    if (erroDasAgendas) throw erroDasAgendas;
    if (!agendas?.length) return resultado;

    const { data: organizacao, error: erroDoFuso } = await db
      .from("organizations")
      .select("timezone")
      .eq("id", org)
      .single();
    if (erroDoFuso || !organizacao?.timezone) throw erroDoFuso ?? new Error("fuso_indisponivel");

    const de = new Date(agora.getTime() - DIAS_PARA_TRAS * DIA_MS).toISOString();
    const ate = new Date(agora.getTime() + DIAS_PARA_FRENTE * DIA_MS).toISOString();
    for (const agenda of agendas as { id: string; external_calendar_id: string }[]) {
      try {
        const eventos = await graph.ocupacao(agenda.external_calendar_id, de, ate);
        const itens = eventos.flatMap((e) => ocupacaoDoEvento(e, organizacao.timezone) ?? []);
        const { error } = await db.rpc("fn_microsoft_calendar_save", {
          p_org: org,
          p_calendar: agenda.id,
          p_items: itens,
          p_start: de,
          p_end: ate,
        });
        if (error) throw error;
        resultado.lidas += 1;
      } catch (erro) {
        resultado.falhas += 1;
        logger.warn("[agenda.microsoft.sync] leitura da agenda falhou", {
          calendar_id: agenda.id,
          status: erro instanceof ErroDoGraph ? erro.status : null,
        });
        await db
          .from("calendar_connection_calendars")
          .update({
            sync_error: frase(erro),
            sync_next_attempt_at: new Date(agora.getTime() + RECUO_MS).toISOString(),
          })
          .eq("organization_id", org)
          .eq("id", agenda.id);
      }
    }
  } catch (erro) {
    resultado.falhas += 1;
    try {
      if (erro instanceof PrecisaReconectar) {
        resultado.reconectar = true;
        // A ocupação já lida CONTINUA bloqueando: na dúvida, não ofereça o horário.
        await marcarConexao(db, conexao, {
          status: "token_expired",
          last_sync_error: "A autorização do Outlook venceu. Conecte a conta de novo.",
        });
      } else {
        await marcarConexao(db, conexao, {
          last_sync_error: frase(erro),
          catalog_retry_at: new Date(agora.getTime() + RECUO_MS).toISOString(),
        });
      }
    } catch {
      /* o diagnóstico não pode derrubar as outras conexões da rodada */
    }
    logger.warn("[agenda.microsoft.sync] conexão falhou", {
      connection_id: conexao.id,
      reconectar: resultado.reconectar,
      status: erro instanceof ErroDoGraph ? erro.status : null,
    });
  }
  return resultado;
}
