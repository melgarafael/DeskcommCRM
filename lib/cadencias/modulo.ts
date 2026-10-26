/** Duas decisões: instalação do módulo e habilitação explícita desta empresa. */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ehOperante } from "@/lib/organizacao/operante";
import { moduloLigado } from "@/lib/instalacao/modulos";

export function cadenciasHabilitadas(settings: unknown): boolean {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return false;
  const value = (settings as { cadencias?: unknown }).cadencias;
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    (value as { enabled?: unknown }).enabled === true;
}

/** Sem memo: desativar precisa impedir o próximo efeito do worker/pixel. */
export async function cadenciasLigadas(db: SupabaseClient, orgId: string): Promise<boolean> {
  try {
  if (!(await moduloLigado(db, "cadencias"))) return false;
  const { data, error } = await db.from("organizations").select("settings, status").eq("id", orgId).maybeSingle();
  return !error && ehOperante(data?.status) && cadenciasHabilitadas(data?.settings);
  } catch { return false; }
}
