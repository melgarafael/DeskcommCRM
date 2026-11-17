/**
 * A AÇÃO `create_or_move_lead` QUE APONTA PARA UMA ETAPA DE PERDA PRECISA DO MOTIVO — NA PORTA.
 *
 * ─── O defeito que este arquivo fecha (#4297) ────────────────────────────────
 *
 * O arrasto, o lote, a IA e a automação movem etapa pelo MESMO decisor
 * (`decideMotivoDaPerda`, lib/leads/motivo-da-perda.ts, issue #917): etapa de
 * perda sem motivo é recusada com 422 `lost_reason_required`. A ação de
 * automação não tinha ONDE informar o motivo — a config dela era só
 * `pipeline_id` + `stage_id` —, então toda regra que apontava para a etapa de
 * perda falhava em execução (medido: 165 execuções `failed` numa passada de
 * `lead.stage_stale`).
 *
 * A recusa certa é no CADASTRO: quem monta a regra vê o campo, escolhe o motivo
 * e a regra nasce capaz de fazer o que promete. Deixar para a execução
 * significaria uma regra "salva" que produz um card parado por evento.
 *
 * ─── O que este arquivo NÃO decide ──────────────────────────────────────────
 *
 * Não decide se falta motivo em TEMPO DE EXECUÇÃO — isso continua sendo do
 * `decideMotivoDaPerda`, dentro do `moveLeadHandler`. Aqui só se responde a
 * pergunta da PORTA: "alguma ação desta regra aponta para uma etapa de perda
 * declaradamente sem motivo?". Regra antiga (gravada antes deste campo) passa
 * pela porta como sempre passou e falha em execução com o código real — o
 * recibo mostra `lost_reason_required`, nunca `internal_error`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";

/** O nome do campo na config — é ele que a recusa cita. */
export const CAMPO_DO_MOTIVO_DA_PERDA = "Motivo da perda";

/** O texto base da recusa (o `traduzir` a leva para o espanhol). */
export const MENSAGEM_ETAPA_DE_PERDA_SEM_MOTIVO =
  "Escolha o “Motivo da perda” nesta ação: a etapa de destino fecha o negócio como perdido, e um negócio não pode ser perdido sem motivo.";

/** A ação como o jsonb a guarda — só o que esta régua lê. */
interface AcaoDaRegra {
  type?: unknown;
  config?: unknown;
}

/** A etapa como `crm_stages` a devolve — só o que esta régua lê. */
export interface EtapaParaOMotivo {
  id: string;
  name?: string | null;
  is_lost?: boolean | null;
}

/** O motivo informado na config, aparado — `""` quando não há (regra antiga). */
export function motivoDaPerdaDaAcao(config: unknown): string {
  const valor = (config as { lost_reason?: unknown } | null | undefined)?.lost_reason;
  return typeof valor === "string" ? valor.trim() : "";
}

/**
 * As ações `create_or_move_lead` que apontam para etapa de perda SEM motivo.
 *
 * `etapas` são as etapas CITADAS pelas ações (quem chama lê do banco, uma vez).
 * Etapa que não está na lista é etapa de outro tenant/inexistente: quem recusa
 * isso é a execução, com o código dela — aqui o silêncio é o certo, porque
 * inventar uma recusa de perda para um id que não é etapa de perda seria mentir
 * sobre o motivo.
 */
export function acoesDePerdaSemMotivo(
  acoes: readonly AcaoDaRegra[] | undefined,
  etapas: readonly EtapaParaOMotivo[],
): Array<{ indice: number; etapa: EtapaParaOMotivo }> {
  const porId = new Map(etapas.map((etapa) => [etapa.id, etapa]));
  const faltando: Array<{ indice: number; etapa: EtapaParaOMotivo }> = [];
  (acoes ?? []).forEach((acao, indice) => {
    if (acao?.type !== "create_or_move_lead") return;
    const config = (acao.config ?? {}) as { stage_id?: unknown };
    const etapa = typeof config.stage_id === "string" ? porId.get(config.stage_id) : undefined;
    if (!etapa || etapa.is_lost !== true) return;
    if (motivoDaPerdaDaAcao(config).length > 0) return;
    faltando.push({ indice, etapa });
  });
  return faltando;
}

/** Os `stage_id` que alguma ação `create_or_move_lead` cita — o recorte da leitura. */
export function etapasCitadasPelasAcoes(
  acoes: readonly AcaoDaRegra[] | undefined,
): string[] {
  const ids = new Set<string>();
  for (const acao of acoes ?? []) {
    if (acao?.type !== "create_or_move_lead") continue;
    const stageId = (acao.config as { stage_id?: unknown } | null | undefined)?.stage_id;
    if (typeof stageId === "string" && stageId.length > 0) ids.add(stageId);
  }
  return [...ids];
}

/**
 * As etapas citadas pelas ações, lidas na organização da regra.
 *
 * Erro de banco sobe como `{ erro }`: tratar a falha da leitura como "não há
 * etapa de perda" deixaria passar exatamente a regra que a porta existe para
 * recusar.
 */
export async function lerEtapasDasAcoes(
  supabase: SupabaseClient,
  orgId: string,
  acoes: readonly AcaoDaRegra[] | undefined,
): Promise<{ erro: string } | { etapas: EtapaParaOMotivo[] }> {
  const ids = etapasCitadasPelasAcoes(acoes);
  if (ids.length === 0) return { etapas: [] };

  const { data, error } = await supabase
    .from("crm_stages")
    .select("id, name, is_lost")
    .eq("organization_id", orgId)
    .in("id", ids);
  if (error) return { erro: error.message };
  return { etapas: (data ?? []) as EtapaParaOMotivo[] };
}

/** A frase da recusa, com o nome da etapa: é o que a tela mostra ao salvar. */
export function mensagemDaEtapaDePerdaSemMotivo(
  etapas: readonly EtapaParaOMotivo[],
  idioma: Idioma,
): string {
  const nomes = etapas
    .map((etapa) => (etapa.name ?? "").trim())
    .filter((nome) => nome.length > 0)
    .map((nome) => `“${nome}”`);
  if (nomes.length === 0) return traduzir(MENSAGEM_ETAPA_DE_PERDA_SEM_MOTIVO, idioma);
  return `${traduzir(MENSAGEM_ETAPA_DE_PERDA_SEM_MOTIVO, idioma)} ${traduzir(
    "Etapa de perda: {etapas}.",
    idioma,
  ).replace("{etapas}", nomes.join(", "))}`;
}
