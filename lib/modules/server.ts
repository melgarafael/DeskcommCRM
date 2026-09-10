import { createClient } from "@/lib/supabase/server";
import { lerModulos } from "./config";

/** orgId vem do contexto autenticado. RLS permanece aplicada na leitura. */
export async function carregarModulos(orgId: string) {
  const db = await createClient();
  const { data, error } = await db.from("organizations").select("settings").eq("id", orgId).single();
  if (error) throw new Error("modules_read_failed");
  return lerModulos(data.settings);
}
