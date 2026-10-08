/**
 * A RODADA HORÁRIA DA COBRANÇA (spec da cobrança do revendedor §8).
 *
 * Três passos, nesta ordem:
 *  1. reconciliação — relê pela API quem `fn_cobranca_reconciliaveis` marca
 *     `precisa_reler`: 50 por rodada, a nunca lida primeiro. Cura o webhook
 *     perdido, o provedor que desistiu de avisar e a VPS que ficou fora do ar;
 *  2. régua só com o banco para as demais. Quem teve a leitura FALHANDO nesta
 *     rodada não passa pela régua: com o provedor fora, suspender seria decidir
 *     sobre uma linha velha;
 *  3. aviso de 80% do teto de IA do plano, um por empresa por mês (a função
 *     do banco deduplica); de 100% em diante quem fala é o bloqueio do motor.
 * Cada empresa é isolada: a falha de uma vira contagem e log, e a rodada segue.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { AcaoDaRegua } from "@/lib/cobranca/regua";
import { traduzir } from "@/lib/i18n/dicionario";
import { normalizarIdioma, type Idioma } from "@/lib/i18n/idiomas";
import { logger } from "@/lib/logger";
import { ehOperante } from "@/lib/organizacao/operante";

import { aplicarRegua, sincronizar, type DependenciasDaCobranca } from "./sincronizar";

export interface ResumoDaRodada {
  relidas: number;
  falhas: number;
  avisos: number;
  suspensas: number;
  reativadas: number;
  canceladas: number;
  avisosDeIa: number;
}

export const LIMITE_DA_RECONCILIACAO = 50;
const LIMIAR_DO_AVISO_DE_IA = 0.8;

interface Reconciliavel {
  organization_id: string;
  relida_em: string | null;
  precisa_reler: boolean;
}

const instante = (v: string | null) => (v === null ? Number.MIN_SAFE_INTEGER : Date.parse(v));

export async function rodadaDaCobranca(admin: SupabaseClient, deps: DependenciasDaCobranca = {}): Promise<ResumoDaRodada> {
  const resumo: ResumoDaRodada = { relidas: 0, falhas: 0, avisos: 0, suspensas: 0, reativadas: 0, canceladas: 0, avisosDeIa: 0 };
  const contar = (acao: AcaoDaRegua["tipo"]) => {
    if (acao === "avisar") resumo.avisos += 1;
    else if (acao === "suspender") resumo.suspensas += 1;
    else if (acao === "reativar") resumo.reativadas += 1;
    else if (acao === "cancelar_no_provedor") resumo.canceladas += 1;
  };
  const falhou = (org: string, e: unknown) => {
    resumo.falhas += 1;
    logger.error("cobranca.rodada_falhou", { organization_id: org, erro: e instanceof Error ? e.message : "desconhecido" });
  };

  const { data: conjunto, error } = await admin.rpc("fn_cobranca_reconciliaveis");
  if (error) throw new Error(`cobranca: reconciliáveis ilegíveis (${error.code ?? "sem_codigo"})`);
  const fila = ((conjunto ?? []) as Reconciliavel[])
    .filter((l) => l.precisa_reler)
    .sort((a, b) => instante(a.relida_em) - instante(b.relida_em))
    .slice(0, LIMITE_DA_RECONCILIACAO);

  const jaVistas = new Set<string>();
  for (const { organization_id: org } of fila) {
    jaVistas.add(org);
    try {
      const r = await sincronizar(admin, org, deps);
      if (r.tipo === "falhou") resumo.falhas += 1;
      // sem provedor a régua já rodou dentro de sincronizar: a ação aconteceu e tem de entrar no resumo
      if (r.tipo === "sem_provedor") contar(r.acao);
      if (r.tipo === "aplicada") {
        resumo.relidas += 1;
        contar(r.acao);
      }
    } catch (e) {
      falhou(org, e);
    }
  }

  const { data: todas, error: erroDaLista } = await admin
    .from("cobranca_assinaturas")
    .select("organization_id")
    .not("organization_id", "is", null);
  if (erroDaLista) throw new Error(`cobranca: assinaturas ilegíveis (${erroDaLista.code ?? "sem_codigo"})`);
  for (const { organization_id: org } of (todas ?? []) as Array<{ organization_id: string }>) {
    if (jaVistas.has(org)) continue;
    try {
      contar(await aplicarRegua(admin, org, deps));
    } catch (e) {
      falhou(org, e);
    }
  }

  resumo.avisosDeIa = await avisarTetoDeIa(admin);
  return resumo;
}

async function avisarTetoDeIa(admin: SupabaseClient): Promise<number> {
  const { data: planos, error } = await admin
    .from("cobranca_planos")
    .select("id, teto_ia_usd_cents")
    .not("teto_ia_usd_cents", "is", null);
  if (error) throw new Error(`cobranca: planos ilegíveis (${error.code ?? "sem_codigo"})`);
  const tetoDoPlano = new Map(((planos ?? []) as Array<{ id: string; teto_ia_usd_cents: number }>).map((p) => [p.id, p.teto_ia_usd_cents]));
  if (tetoDoPlano.size === 0) return 0;

  const { data: linhas, error: erroDasLinhas } = await admin
    .from("cobranca_assinaturas")
    .select("organization_id, plano_id")
    .in("plano_id", [...tetoDoPlano.keys()]);
  if (erroDasLinhas) throw new Error(`cobranca: assinaturas com teto ilegíveis (${erroDasLinhas.code ?? "sem_codigo"})`);
  const comTeto = (linhas ?? []) as Array<{ organization_id: string; plano_id: string }>;
  if (comTeto.length === 0) return 0;

  const { data: orgs, error: erroDasOrgs } = await admin
    .from("organizations")
    .select("id, status, locale")
    .in("id", comTeto.map((l) => l.organization_id));
  if (erroDasOrgs) throw new Error(`cobranca: empresas ilegíveis (${erroDasOrgs.code ?? "sem_codigo"})`);
  const idiomaDe = new Map<string, Idioma>(
    ((orgs ?? []) as Array<{ id: string; status: string; locale: string | null }>)
      .filter((o) => ehOperante(o.status))
      .map((o) => [o.id, normalizarIdioma(o.locale)]),
  );

  let avisos = 0;
  for (const { organization_id: org, plano_id: plano } of comTeto) {
    const idioma = idiomaDe.get(org);
    const teto = tetoDoPlano.get(plano);
    if (idioma === undefined || teto === undefined) continue;
    const { data: gastoLido, error: erroDoGasto } = await admin.rpc("fn_gasto_de_ia_do_mes", { p_org: org });
    if (erroDoGasto) {
      logger.warn("cobranca.gasto_de_ia_ilegivel", { organization_id: org, codigo: erroDoGasto.code ?? null });
      continue;
    }
    const gasto = Number(gastoLido ?? 0);
    if (gasto < teto * LIMIAR_DO_AVISO_DE_IA || gasto >= teto) continue;
    const t = (s: string) => traduzir(s, idioma);
    const usd = (centavos: number) => (centavos / 100).toFixed(2);
    const { data: ganhou, error: erroDoAviso } = await admin.rpc("fn_cobranca_avisar_teto_de_ia", {
      p_org: org,
      p_titulo: t("O uso de IA do plano chegou a 80%"),
      p_corpo: t(
        "Neste mês a empresa já usou US$ {gasto} de US$ {teto} incluídos no plano. Ao chegar ao limite, as conversas passam para a equipe. Para aumentar, troque de plano em Plano e cobrança.",
      )
        .replace("{gasto}", usd(gasto))
        .replace("{teto}", usd(teto)),
    });
    if (erroDoAviso) {
      logger.warn("cobranca.aviso_de_ia_nao_registrado", { organization_id: org, codigo: erroDoAviso.code ?? null });
      continue;
    }
    if (ganhou === true) avisos += 1;
  }
  return avisos;
}
