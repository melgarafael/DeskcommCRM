import type { SupabaseClient } from "@supabase/supabase-js";

import { partesNoFuso } from "@/lib/agenda/fuso";
import { fusoUtilizavel } from "@/lib/tempo/fusos";

const doisDigitos = (n: number): string => String(n).padStart(2, "0");

/**
 * D8 — toda data de proposta (ano da numeração, "hoje" do vencimento,
 * validade padrão) passa por aqui, nunca por `new Date().toISOString()`
 * direto (isso lê UTC, não o fuso da organização — auditoria de produção,
 * spec D8: 3 organizações reais, 2 fusos diferentes).
 */
export function dataIsoNoFuso(instante: Date, fuso: string): string {
  const fusoEmVigor = fusoUtilizavel(fuso);
  const p = partesNoFuso(instante, fusoEmVigor);
  return `${p.ano}-${doisDigitos(p.mes)}-${doisDigitos(p.dia)}`;
}

export function anoNoFuso(instante: Date, fuso: string): number {
  return partesNoFuso(instante, fusoUtilizavel(fuso)).ano;
}

export function somarDiasNoFuso(instante: Date, dias: number, fuso: string): string {
  // A validade conta dias de calendário, não blocos de 24h: em Lisboa,
  // atravessar o horário de verão perto da meia-noite mudava o prazo em um dia.
  // UTC é só a âncora para somar ao DIA LOCAL; não reconverta esta data ao fuso.
  const futuro = new Date(`${dataIsoNoFuso(instante, fuso)}T00:00:00.000Z`);
  futuro.setUTCDate(futuro.getUTCDate() + dias);
  return futuro.toISOString().slice(0, 10);
}

/** `organizations.timezone` não tem CHECK — nunca lança, degrada para o padrão. */
export async function fusoDaOrganizacao(db: SupabaseClient, organizationId: string): Promise<string> {
  const { data } = await db.from("organizations").select("timezone").eq("id", organizationId).maybeSingle();
  return fusoUtilizavel((data as { timezone?: string | null } | null)?.timezone);
}
