/**
 * O servidor recusa o gatilho por data apontado para um campo do CONTATO.
 *
 * A varredura `app/api/v1/cron/lead-date-field-due` lê `crm_leads.custom_fields`;
 * o valor de um campo de escopo `contato` (#2791) mora em `contacts.custom_fields`.
 * Uma regra assim seria salva e nunca dispararia, sem erro e sem log. O seletor
 * da tela já não oferece o campo (`camposDeDataDoNegocio`); esta é a mesma regra
 * pela porta da API, da regra antiga regravada e do religar pelo MCP
 * (`definirRegraAtiva`).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { configDoGatilhoDeData, GATILHO_DE_DATA_DO_FUNIL } from "@/lib/automation/gatilho-de-data-do-funil";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";
import { campoEhDoContato, camposDoFunil, escopoDoCampo } from "@/lib/leads/campos-do-funil";

export const MENSAGEM_CAMPO_DE_DATA_DO_CONTATO =
  "Este campo de data é do contato, e o gatilho por data só lê campos do negócio. Escolha um campo de data do negócio.";

/**
 * `{ doContato: true }` quando a regra é do gatilho por data e a chave está
 * declarada no funil como campo do contato. Erro de banco sobe como `{ erro }`.
 */
export async function campoDoGatilhoDeDataEhDoContato(
  supabase: SupabaseClient,
  orgId: string,
  triggerEvent: string,
  triggerConfig: unknown,
): Promise<{ erro: string } | { doContato: boolean }> {
  if (triggerEvent !== GATILHO_DE_DATA_DO_FUNIL) return { doContato: false };
  const config = configDoGatilhoDeData(triggerConfig);
  // ponytail: funil que não é uuid não casa com negócio nenhum; recusar isso é outra regra.
  if (!config || !z.uuid().safeParse(config.pipeline_id).success) return { doContato: false };

  const { data, error } = await supabase
    .from("crm_pipelines")
    .select("settings")
    .eq("id", config.pipeline_id)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (error) return { erro: error.message };

  const settings = (data?.settings ?? null) as Record<string, unknown> | null;
  return { doContato: campoEhDoContato(settings, config.campo) };
}

/**
 * A mesma regra pela porta de trás: marcar como Contato, nas configurações do
 * funil, um campo que uma regra ATIVA do gatilho por data já lê. A regra seguiria
 * ligada e deixaria de disparar em silêncio. Devolve o nome das regras que
 * perderiam o campo — vazio quando nenhum campo passou a ser do contato.
 */
export async function regrasDeDataQuePerdemOCampo(
  supabase: SupabaseClient,
  orgId: string,
  pipelineId: string,
  antes: Record<string, unknown> | null,
  depois: Record<string, unknown> | null,
): Promise<{ erro: string } | { nomes: string[] }> {
  const viramContato = camposDoFunil(depois)
    .filter((campo) => escopoDoCampo(campo) === "contato" && !campoEhDoContato(antes, campo.key))
    .map((campo) => campo.key);
  if (viramContato.length === 0) return { nomes: [] };

  const { data, error } = await supabase
    .from("automation_rules")
    .select("name, trigger_config")
    .eq("organization_id", orgId)
    .eq("is_active", true)
    .eq("trigger_event", GATILHO_DE_DATA_DO_FUNIL);
  if (error) return { erro: error.message };

  const nomes = (data ?? [])
    .filter((regra) => {
      const config = configDoGatilhoDeData(regra.trigger_config);
      return config?.pipeline_id === pipelineId && viramContato.includes(config.campo);
    })
    .map((regra) => String(regra.name));
  return { nomes };
}

/** A recusa legível: até três nomes, e o resto contado. */
export function mensagemDasRegrasQuePerdemOCampo(nomes: string[], idioma: Idioma): string {
  const t = (texto: string) => traduzir(texto, idioma);
  const citadas = nomes.slice(0, 3).map((nome) => `"${nome}"`).join(", ");
  const resto = nomes.length - 3;
  const regras = resto > 0 ? `${citadas} ${t("e mais {n}").replace("{n}", String(resto))}` : citadas;
  return t(
    nomes.length === 1
      ? "A regra {regras} usa no gatilho por data um campo que você marcou como Contato, e o gatilho só lê campos do negócio: ela deixaria de disparar. Troque o campo da regra ou desligue-a antes."
      : "As regras {regras} usam no gatilho por data um campo que você marcou como Contato, e o gatilho só lê campos do negócio: elas deixariam de disparar. Troque o campo das regras ou desligue-as antes.",
  ).replace("{regras}", () => regras);
}
