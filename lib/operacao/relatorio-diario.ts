/**
 * O RELATÓRIO DIÁRIO DA OPERAÇÃO — a Operação do dia congelada no CRM.
 *
 * Uma linha por organização e dia (`relatorios_operacao_diarios`, único em
 * `(organization_id, dia)`). Dois escritores, e os dois pelo service role com
 * a organização ESCRITA:
 *
 *   - o cron (`app/api/v1/cron/relatorio-operacao-diario`), que só CRIA:
 *     `insert ... on conflict do nothing`. Rodar duas vezes, ou duas réplicas
 *     ao mesmo tempo, deixa uma linha só — quem chega depois não escreve nada.
 *   - o botão "Gerar agora" (`POST /api/v1/operacao/relatorios`), que pode
 *     REGERAR: `on conflict do update`. Repetir o clique substitui o conteúdo
 *     do dia, nunca duplica.
 *
 * O conteúdo é o formato da tela (`OperacaoDoDia`) passado por `congelar`:
 * só fatos (ids, canal, situação, etiquetas, instantes, códigos, produtos do
 * catálogo achados pela busca), NUNCA nome, telefone, @, prévia, resumo ou o
 * termo buscado (texto do cliente) — a cascata de
 * anonimização da LGPD não alcança um jsonb guardado. Não há coluna de texto:
 * o texto do relatório é montado na leitura (`textoDoRelatorio` sobre o
 * conteúdo `hidratar`-ado), com o nome que o contato tem AGORA.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { env } from "@/lib/env";
import { normalizarIdioma, type Idioma } from "@/lib/i18n/idiomas";
import { fusoUtilizavel } from "@/lib/tempo/fusos";

import { montarOperacaoDoDia, nomesPelaFuncao } from "./operacao-do-dia";
import { type ConfiguracaoDaOperacao, lerConfiguracao } from "./regras";
import { congelar } from "./conteudo";
import type { OperacaoDoDia } from "./tipos";

export const TABELA_DOS_RELATORIOS = "relatorios_operacao_diarios";

export interface ContextoDaOrganizacao {
  fuso: string;
  idioma: Idioma;
  config: ConfiguracaoDaOperacao;
}

/** Fuso, idioma e configuração da organização, lidos com o id escrito. Nunca lança por valor torto. */
export async function contextoDaOrganizacao(db: SupabaseClient, orgId: string): Promise<ContextoDaOrganizacao> {
  const { data, error } = await db
    .from("organizations")
    .select("timezone, locale, settings")
    .eq("id", orgId)
    .maybeSingle();
  if (error) throw new Error(`organização não lida: ${error.message}`);
  const linha = (data ?? {}) as { timezone?: string | null; locale?: string | null; settings?: unknown };
  return {
    fuso: fusoUtilizavel(linha.timezone),
    idioma: normalizarIdioma(linha.locale),
    config: lerConfiguracao(linha.settings),
  };
}

export function urlPublicaDoApp(): string {
  return (env.NEXT_PUBLIC_APP_URL ?? "").trim().replace(/\/+$/, "");
}

export interface RelatorioGerado {
  /** `true` quando ESTA chamada gravou a linha (criou, ou regerou). */
  gravou: boolean;
  id: string | null;
  conteudo: OperacaoDoDia;
}

export async function gerarRelatorioDiario(input: {
  admin: SupabaseClient;
  orgId: string;
  dia: string;
  geradoPor: "cron" | "usuario";
  /** `true` regera o dia (on conflict do update); `false` só cria (on conflict do nothing). */
  substituir: boolean;
  /**
   * Regerar por cima de uma linha MANUAL gravada antes deste instante (a hora
   * marcada daquele dia): `update` condicionado a `gerado_por = 'usuario'` e
   * `gerado_em <` o instante. Se alguém regerou depois da hora, ou outra rodada
   * já regerou, o update não acha linha e nada é gravado — sem laço.
   */
  substituirManualAntesDe?: string;
  contexto?: ContextoDaOrganizacao;
  agora?: Date;
}): Promise<RelatorioGerado> {
  const { admin, orgId, dia } = input;
  const agora = input.agora ?? new Date();
  const ctx = input.contexto ?? (await contextoDaOrganizacao(admin, orgId));
  const conteudo = await montarOperacaoDoDia({
    db: admin,
    orgId,
    dia,
    fuso: ctx.fuso,
    config: ctx.config,
    agora,
    nomesDaEquipe: nomesPelaFuncao(admin, orgId),
  });
  const linha = {
    organization_id: orgId,
    dia,
    fuso: ctx.fuso,
    gerado_em: agora.toISOString(),
    gerado_por: input.geradoPor,
    conteudo: congelar(conteudo),
  };
  if (input.substituirManualAntesDe) {
    const { data, error } = await admin
      .from("relatorios_operacao_diarios")
      .update({ gerado_em: linha.gerado_em, gerado_por: linha.gerado_por, fuso: linha.fuso, conteudo: linha.conteudo })
      .eq("organization_id", orgId)
      .eq("dia", dia)
      .eq("gerado_por", "usuario")
      .lt("gerado_em", input.substituirManualAntesDe)
      .select("id");
    if (error) throw new Error(`relatório não regerado: ${error.message}`);
    const gravadas = (data ?? []) as Array<{ id: string }>;
    return { gravou: gravadas.length > 0, id: gravadas[0]?.id ?? null, conteudo };
  }
  const { data, error } = await admin
    // O nome LITERAL, e não a constante: tests/invariants/on-conflict-aponta-para-constraint-real.test.ts
    // acha a tabela do upsert pelo `.from("...")` mais próximo.
    .from("relatorios_operacao_diarios")
    .upsert(linha, { onConflict: "organization_id,dia", ignoreDuplicates: !input.substituir })
    .select("id");
  if (error) throw new Error(`relatório não gravado: ${error.message}`);
  const gravadas = (data ?? []) as Array<{ id: string }>;
  return { gravou: gravadas.length > 0, id: gravadas[0]?.id ?? null, conteudo };
}
