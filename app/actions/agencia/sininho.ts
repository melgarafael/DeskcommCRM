"use server";

import { contextoDaAgencia } from "@/lib/agencia/acesso";
import { idSchema } from "@/lib/agencia/schemas";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * O sininho lê e marca pelo SERVIDOR: o cookie de sessão é HttpOnly (CLAUDE.md
 * › Auth), então o client do navegador fala com o PostgREST como `anon` e a
 * leitura direta de `agencia_avisos` volta 401 — medido no teste em 23/10/2026.
 * Aqui o membro vem do `getUser()`, e toda consulta filtra pelo id DELE.
 */
export interface AvisoDoSininho {
  id: string;
  titulo: string;
  corpo: string | null;
  link: string | null;
  criado_em: string;
  lido_em: string | null;
}

const LIMITE = 30;

async function membroAtual(): Promise<string | null> {
  const { decisao, membro } = await contextoDaAgencia();
  return decisao.tipo === "liberado" ? (membro?.id ?? null) : null;
}

export async function listarMeusAvisos(): Promise<AvisoDoSininho[]> {
  const membroId = await membroAtual();
  if (!membroId) return [];
  const { data } = await createAdminClient()
    .from("agencia_avisos")
    .select("id, titulo, corpo, link, criado_em, lido_em")
    .eq("membro_id", membroId)
    .order("criado_em", { ascending: false })
    .limit(LIMITE);
  return (data ?? []) as AvisoDoSininho[];
}

export async function marcarAvisoComoLido(avisoId: string): Promise<void> {
  const membroId = await membroAtual();
  if (!membroId || !idSchema.safeParse(avisoId).success) return;
  await createAdminClient()
    .from("agencia_avisos")
    .update({ lido_em: new Date().toISOString() })
    .eq("id", avisoId)
    .eq("membro_id", membroId)
    .is("lido_em", null);
}

export async function marcarTodosComoLidos(): Promise<void> {
  const membroId = await membroAtual();
  if (!membroId) return;
  await createAdminClient()
    .from("agencia_avisos")
    .update({ lido_em: new Date().toISOString() })
    .eq("membro_id", membroId)
    .is("lido_em", null);
}
