/**
 * O AVISO NA CENTRAL quando o cliente se interessa por um item de receita e o
 * lead NÃO pode nascer (Spec 25, R5 / D6, item 4 do checklist: nenhuma demanda
 * sem próximo passo). Mesmo molde de `aviso-de-destino-recusado.ts`: `kind =
 * "other"` (sem migration), dedup por aviso aberto, NUNCA LANÇA.
 *
 * Não existe helper genérico de aviso na casa — cada produtor tem título e
 * corpo próprios —, então este é o produtor desta peça.
 *
 * Sem PII do cliente: o aviso aponta para o CONTATO (`ref_kind = contact`), e
 * quem abre vê o resto com a permissão que tem. O corpo leva só título do item,
 * referência e nome da receita (dado do admin/da consulta, não do cliente).
 *
 * Idioma da ORGANIZAÇÃO, como os irmãos.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { traduzir } from "@/lib/i18n/dicionario";
import { normalizarIdioma } from "@/lib/i18n/idiomas";
import { logger } from "@/lib/logger";

export type MotivoDoAvisoDeInteresse = "sem_destino" | "destino_indisponivel" | "etapa_exige_campos";

const TITULO = "Interesse em item sem funil de destino";
const CORPOS: Record<MotivoDoAvisoDeInteresse, string> = {
  sem_destino:
    "O agente identificou interesse em {titulo} ({referencia}), mas a receita {receita} não tem funil de destino. Configure em Integração de dados.",
  destino_indisponivel:
    "O agente identificou interesse em {titulo} ({referencia}), mas o funil de destino da receita {receita} não está mais disponível. Escolha outro em Integração de dados.",
  etapa_exige_campos:
    "O agente identificou interesse em {titulo} ({referencia}), mas a etapa de destino da receita {receita} exige campos que o cliente ainda não informou. Ajuste a etapa ou escolha outra em Integração de dados.",
};

export interface EntradaDoAvisoDeInteresse {
  organizationId: string;
  contactId: string;
  motivo: MotivoDoAvisoDeInteresse;
  titulo: string;
  referencia: string;
  receita: string;
}

/** `true` = há um aviso aberto para este contato e item (novo ou já existente). */
export async function abreAvisoDeInteresse(
  admin: SupabaseClient,
  entrada: EntradaDoAvisoDeInteresse,
): Promise<boolean> {
  try {
    const { data: org } = await admin
      .from("organizations")
      .select("locale")
      .eq("id", entrada.organizationId)
      .maybeSingle();
    const idioma = normalizarIdioma((org as { locale?: string | null } | null)?.locale);
    const titulo = traduzir(TITULO, idioma);
    const corpo = traduzir(CORPOS[entrada.motivo], idioma)
      .replace("{titulo}", () => entrada.titulo)
      .replace("{referencia}", () => entrada.referencia)
      .replace("{receita}", () => entrada.receita);

    const { data: jaAberto, error: erroDaBusca } = await admin
      .from("agent_inbox_items")
      .select("id")
      .eq("organization_id", entrada.organizationId)
      .eq("kind", "other")
      .eq("ref_kind", "contact")
      .eq("ref_id", entrada.contactId)
      .eq("status", "open")
      .eq("title", titulo)
      .eq("body", corpo)
      .limit(1)
      .maybeSingle();
    if (erroDaBusca) throw new Error(`busca de aviso aberto: ${erroDaBusca.message}`);
    if (jaAberto) return true;

    const { error } = await admin.from("agent_inbox_items").insert({
      organization_id: entrada.organizationId,
      kind: "other",
      severity: "warn",
      title: titulo,
      body: corpo,
      ref_kind: "contact",
      ref_id: entrada.contactId,
    });
    if (error) throw new Error(`aviso não entrou na Central: ${error.message}`);
    return true;
  } catch (err) {
    logger.warn("[interesse-em-item] não abri o aviso na Central", {
      organizationId: entrada.organizationId,
      motivo: entrada.motivo,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
    });
    return false;
  }
}
