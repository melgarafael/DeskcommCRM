/**
 * A chave de MAPAS da organização (migration 0504, `map_provider_credentials`).
 *
 * Opcional: sem chave, o pino do WhatsApp segue exatamente como antes (só o
 * link do mapa). Mesma cifra das outras integrações (`fn_encrypt_oauth`), e a
 * tabela é server-side only — RLS ligada sem policies, grants revogados. A
 * chave nunca volta ao browser: a tela vê só os 4 últimos caracteres.
 *
 * ⚠️ Service role: toda consulta aqui filtra `organization_id` à mão, e o id
 * vem de fonte confiável (sessão, token do webhook), nunca do corpo do pedido.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { logger } from "@/lib/logger";
import { decryptWebhookSecret, encryptWebhookSecret } from "@/lib/webhooks/secrets";

import {
  geocodificarReverso,
  idiomaDaConsulta,
  type EnderecoAproximado,
  type ResultadoDaGeocodificacao,
} from "./geocodificacao";

export const PROVEDOR_DE_MAPAS = "google_maps" as const;

/** Chave do Google: letras, números, `_` e `-`. O formato barra colagem errada antes de cifrar. */
export const chaveDeMapasSchema = z
  .string()
  .trim()
  .min(20)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/);

export interface EstadoDaChaveDeMapas {
  configurada: boolean;
  ultimos4: string | null;
  atualizadaEm: string | null;
}

export async function estadoDaChaveDeMapas(
  admin: SupabaseClient,
  organizationId: string,
): Promise<EstadoDaChaveDeMapas> {
  const { data, error } = await admin
    .from("map_provider_credentials")
    .select("api_key_last4, updated_at")
    .eq("organization_id", organizationId)
    .eq("provider", PROVEDOR_DE_MAPAS)
    .maybeSingle();
  if (error) throw new Error(`leitura da chave de mapas falhou: ${error.message}`);
  const linha = data as { api_key_last4: string; updated_at: string } | null;
  return {
    configurada: Boolean(linha),
    ultimos4: linha?.api_key_last4 ?? null,
    atualizadaEm: linha?.updated_at ?? null,
  };
}

/** A chave em claro, ou `null` (sem chave, leitura falhou, cifra indisponível). Nunca lança. */
export async function lerChaveDeMapas(admin: SupabaseClient, organizationId: string): Promise<string | null> {
  try {
    const { data, error } = await admin
      .from("map_provider_credentials")
      .select("api_key_encrypted")
      .eq("organization_id", organizationId)
      .eq("provider", PROVEDOR_DE_MAPAS)
      .maybeSingle();
    if (error) {
      logger.warn("[mapas] leitura da chave falhou", { organization_id: organizationId, error: error.message });
      return null;
    }
    const cifrada = (data as { api_key_encrypted: string | null } | null)?.api_key_encrypted;
    if (!cifrada) return null;
    return await decryptWebhookSecret(admin, cifrada);
  } catch (err) {
    logger.warn("[mapas] leitura da chave falhou", {
      organization_id: organizationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export type ResultadoDeGravacao = { ok: true; ultimos4: string } | { ok: false; erro: "cifra_indisponivel" | "erro_ao_gravar"; detalhe?: string };

export async function guardarChaveDeMapas(
  admin: SupabaseClient,
  input: { organizationId: string; chave: string; atorId: string },
): Promise<ResultadoDeGravacao> {
  const cifrada = await encryptWebhookSecret(admin, input.chave);
  // Sem cifra, não grava: texto claro no banco não é um "modo degradado".
  if (!cifrada) return { ok: false, erro: "cifra_indisponivel" };
  const ultimos4 = input.chave.slice(-4);
  // `upsert` sobre o índice único `(organization_id, provider)`: trocar a chave
  // é gravar de novo, e um `update` casaria zero linhas em quem nunca gravou.
  const { error } = await admin.from("map_provider_credentials").upsert(
    {
      organization_id: input.organizationId,
      provider: PROVEDOR_DE_MAPAS,
      api_key_encrypted: cifrada,
      api_key_last4: ultimos4,
      updated_by: input.atorId,
    },
    { onConflict: "organization_id,provider" },
  );
  if (error) return { ok: false, erro: "erro_ao_gravar", detalhe: error.message };
  return { ok: true, ultimos4 };
}

/** `true` se havia chave e ela saiu. */
export async function removerChaveDeMapas(admin: SupabaseClient, organizationId: string): Promise<boolean> {
  const { data, error } = await admin
    .from("map_provider_credentials")
    .delete()
    .eq("organization_id", organizationId)
    .eq("provider", PROVEDOR_DE_MAPAS)
    .select("id");
  if (error) throw new Error(`remoção da chave de mapas falhou: ${error.message}`);
  return (data ?? []).length > 0;
}

async function localeDaOrganizacao(admin: SupabaseClient, organizationId: string): Promise<string | null> {
  const { data } = await admin.from("organizations").select("locale").eq("id", organizationId).maybeSingle();
  return (data as { locale: string | null } | null)?.locale ?? null;
}

/** Geocodifica um ponto com a chave dada — o botão "Testar" usa antes de gravar. */
export async function testarChaveDeMapas(
  admin: SupabaseClient,
  organizationId: string,
  chave: string,
  ponto: { latitude: number; longitude: number },
): Promise<ResultadoDaGeocodificacao> {
  const idioma = idiomaDaConsulta(await localeDaOrganizacao(admin, organizationId));
  return geocodificarReverso(chave, ponto, { idioma });
}

/**
 * O endereço aproximado de um pino recebido, ou `null`. Sem chave, não faz rede
 * nenhuma. Nunca lança: roda dentro do recebimento da mensagem, e perder o
 * endereço é aceitável — perder a mensagem não.
 */
export async function enderecoAproximadoDoPino(
  admin: SupabaseClient,
  organizationId: string,
  ponto: { latitude: number; longitude: number },
  opcoes: { fetchImpl?: typeof fetch } = {},
): Promise<EnderecoAproximado | null> {
  const chave = await lerChaveDeMapas(admin, organizationId);
  if (!chave) return null;
  try {
    const idioma = idiomaDaConsulta(await localeDaOrganizacao(admin, organizationId));
    const r = await geocodificarReverso(chave, ponto, { idioma, fetchImpl: opcoes.fetchImpl });
    if (r.ok) return r.endereco;
    // O motivo e a mensagem do Google — nunca a URL, que leva a chave.
    logger.warn("[mapas] pino sem endereço aproximado", {
      organization_id: organizationId,
      motivo: r.motivo,
      detalhe: r.detalhe,
    });
    return null;
  } catch (err) {
    logger.warn("[mapas] pino sem endereço aproximado", {
      organization_id: organizationId,
      motivo: "excecao",
      detalhe: err instanceof Error ? err.name : "erro",
    });
    return null;
  }
}
