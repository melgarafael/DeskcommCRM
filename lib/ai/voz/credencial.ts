/**
 * A CHAVE DE VOZ DA ORGANIZAÇÃO — IA › Provedores › "Voz e áudio".
 *
 * Uma linha em `ai_provider_credentials` com `provider = 'google-tts'`, uma por
 * organização. Nada aqui inventa segurança própria: cifrar (AES-256-GCM,
 * `AI_CRED_AES_KEY`), gravar só os 4 últimos em claro, auditar e validar em
 * segundo plano é o miolo de `lib/ai/credenciais/guardar.ts`, o mesmo das chaves
 * de IA. Este arquivo decide só o que é próprio da voz: uma linha por empresa,
 * o rótulo fixo, e a leitura do estado que a tela pode ver.
 *
 * ⚠️ Service role: TODA consulta filtra `organization_id` (vindo da sessão, nunca
 * do corpo) e `provider`. A chave em claro só existe dentro de `lerChaveDaVoz`
 * para ir ao Google — nunca para resposta, log ou auditoria.
 */
import { audit } from "@/lib/audit";
import { guardarCredencial, rotacionarCredencial } from "@/lib/ai/credenciais/guardar";
import { PROVEDOR_DA_VOZ } from "@/lib/ai/pontos/provedores";
import { validateGoogleTtsKey } from "@/lib/ai/provider-validators";
import { byteaToBuffer, decryptKey } from "@/lib/crypto/aes_gcm";
import { env } from "@/lib/env";
import type { createAdminClient } from "@/lib/supabase/admin";
import { z } from "zod";

type Admin = ReturnType<typeof createAdminClient>;

/** O nome da linha. Fixo: a empresa tem UMA chave de voz, e o rótulo não é escolha. */
export const ROTULO_DA_CHAVE_DE_VOZ = "Google Cloud Text-to-Speech";

/**
 * Chave do Google Cloud: letras, números, `_` e `-` (o formato `AIza…`). Barra
 * colagem errada antes de cifrar. É também o que torna "substituir" uma troca
 * pela chave INTEIRA: não existe caminho que aceite máscara ou pedaço.
 */
export const chaveDeVozSchema = z
  .string()
  .trim()
  .min(30)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/);

export interface EstadoDaVoz {
  /** A ORGANIZAÇÃO tem chave cadastrada aqui. */
  configurada: boolean;
  /** `••••` + 4 últimos. `null` sem chave. Nunca mais que isso. */
  mascara: string | null;
  validada: boolean;
  /** Código do último teste que falhou (`auth_failed_403`…), nunca texto do Google. */
  erro: string | null;
  atualizada_em: string | null;
  /**
   * De onde o worker tiraria a chave AGORA: a da organização (validada), a da
   * instalação (`GOOGLE_TTS_API_KEY`) ou nenhuma. A tela usa isto para dizer se
   * a resposta em áudio pode ser ligada.
   */
  em_uso: "organizacao" | "instalacao" | null;
}

interface LinhaSegura {
  id: string;
  api_key_last4: string;
  validated_at: string | null;
  validation_error: string | null;
  updated_at: string;
}

/** Os erros de validação que a tela sabe explicar. Outro texto vira `erro_desconhecido`. */
const ERRO_CONHECIDO = /^(auth_failed_\d{3}|provider_status_\d{3}|network_error|resposta_invalida|sem_vozes_pt_br)$/;

export function mascararUltimos4(last4: string | null | undefined): string | null {
  if (!last4) return null;
  return `••••${last4.slice(-4)}`;
}

async function linhaDaVoz(admin: Admin, organizationId: string): Promise<LinhaSegura | null> {
  const { data, error } = await admin
    .from("ai_provider_credentials_safe")
    .select("id, api_key_last4, validated_at, validation_error, updated_at")
    .eq("organization_id", organizationId)
    .eq("provider", PROVEDOR_DA_VOZ)
    .eq("is_active", true)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error("leitura_da_chave_de_voz_falhou");
  return (data as LinhaSegura | null) ?? null;
}

export function chaveDaInstalacaoConfigurada(): boolean {
  return (env.GOOGLE_TTS_API_KEY ?? "").trim() !== "";
}

export async function estadoDaVoz(admin: Admin, organizationId: string): Promise<EstadoDaVoz> {
  const linha = await linhaDaVoz(admin, organizationId);
  const validada = Boolean(linha?.validated_at);
  const erro = linha?.validation_error
    ? ERRO_CONHECIDO.test(linha.validation_error)
      ? linha.validation_error
      : "erro_desconhecido"
    : null;
  return {
    configurada: linha !== null,
    mascara: mascararUltimos4(linha?.api_key_last4),
    validada,
    erro,
    atualizada_em: linha?.updated_at ?? null,
    em_uso: validada ? "organizacao" : chaveDaInstalacaoConfigurada() ? "instalacao" : null,
  };
}

/**
 * A chave em claro para ir ao Google — a da organização (ativa, validada ou
 * não: testar uma chave recém-colada é justamente o ponto) e, sem ela, a da
 * instalação. `null` = nenhuma. Nunca lança.
 */
export async function lerChaveDaVoz(
  admin: Admin,
  organizationId: string,
): Promise<{ chave: string; origem: "organizacao" | "instalacao" } | null> {
  try {
    const { data, error } = await admin
      .from("ai_provider_credentials")
      .select("api_key_encrypted, api_key_iv, api_key_tag")
      .eq("organization_id", organizationId)
      .eq("provider", PROVEDOR_DA_VOZ)
      .eq("is_active", true)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!error && data) {
      const linha = data as { api_key_encrypted: unknown; api_key_iv: unknown; api_key_tag: unknown };
      const chave = decryptKey({
        ciphertext: byteaToBuffer(linha.api_key_encrypted),
        iv: byteaToBuffer(linha.api_key_iv),
        tag: byteaToBuffer(linha.api_key_tag),
      });
      return { chave, origem: "organizacao" };
    }
  } catch {
    // Decifragem ou leitura falhou: a da organização não serve, e a da
    // instalação não a substitui em silêncio se a linha existe.
    return null;
  }
  const daInstalacao = (env.GOOGLE_TTS_API_KEY ?? "").trim();
  return daInstalacao === "" ? null : { chave: daInstalacao, origem: "instalacao" };
}

export type ResultadoDeGuardarVoz =
  | { ok: true; trocou: boolean }
  | { ok: false; motivo: "cifragem" | "banco" };

/**
 * Grava a chave: sem linha, cria; com linha, SUBSTITUI a chave da mesma linha
 * (sempre a chave inteira — `chaveDeVozSchema`). A auditoria
 * (`ai.credential_created` / `ai.credential_updated`, com `last4`) e a validação
 * em segundo plano vêm do miolo comum.
 */
export async function guardarChaveDeVoz(
  admin: Admin,
  p: { organizationId: string; userId: string; apiKey: string; requestId?: string },
  tentativa = 0,
): Promise<ResultadoDeGuardarVoz> {
  // Ativa ou não: uma linha desativada da voz é a MESMA chave da empresa, e é
  // nela que se substitui (reativando) — senão o rótulo fixo colidiria.
  const { data: achada, error: erroDaBusca } = await admin
    .from("ai_provider_credentials")
    .select("id, is_active")
    .eq("organization_id", p.organizationId)
    .eq("provider", PROVEDOR_DA_VOZ)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (erroDaBusca) return { ok: false, motivo: "banco" };
  const existente = achada as { id: string; is_active: boolean } | null;
  if (existente) {
    const r = await rotacionarCredencial({
      admin,
      orgId: p.organizationId,
      userId: p.userId,
      credentialId: existente.id,
      provider: PROVEDOR_DA_VOZ,
      apiKey: p.apiKey,
      ...(p.requestId ? { requestId: p.requestId } : {}),
    });
    if (!r.ok) return { ok: false, motivo: r.motivo === "cifragem" ? "cifragem" : "banco" };
    if (!existente.is_active) {
      await admin
        .from("ai_provider_credentials")
        .update({ is_active: true })
        .eq("id", existente.id)
        .eq("organization_id", p.organizationId);
    }
    return { ok: true, trocou: true };
  }
  const r = await guardarCredencial({
    admin,
    orgId: p.organizationId,
    userId: p.userId,
    provider: PROVEDOR_DA_VOZ,
    label: ROTULO_DA_CHAVE_DE_VOZ,
    apiKey: p.apiKey,
    ...(p.requestId ? { requestId: p.requestId } : {}),
  });
  if (r.ok) return { ok: true, trocou: false };
  if (r.motivo === "label_em_uso" && tentativa === 0) {
    // Corrida: outro pedido criou a linha agora. Substituir nela é o que a
    // pessoa pediu — "salvar a chave da empresa". Uma vez só: uma linha
    // DESATIVADA com o mesmo rótulo não aparece em `linhaDaVoz`, e repetir
    // sem limite viraria laço.
    return guardarChaveDeVoz(admin, p, 1);
  }
  return { ok: false, motivo: r.motivo === "cifragem" ? "cifragem" : "banco" };
}

/** Remove a chave da organização. `true` se havia. Audita `ai.credential_deleted`, com `last4`. */
export async function removerChaveDeVoz(
  admin: Admin,
  p: { organizationId: string; userId: string; requestId?: string },
): Promise<boolean> {
  const { data, error } = await admin
    .from("ai_provider_credentials")
    .delete()
    .eq("organization_id", p.organizationId)
    .eq("provider", PROVEDOR_DA_VOZ)
    .select("id, api_key_last4");
  if (error) throw new Error("remocao_da_chave_de_voz_falhou");
  const removidas = (data ?? []) as { id: string; api_key_last4: string }[];
  for (const linha of removidas) {
    await audit({
      action: "ai.credential_deleted",
      actorUserId: p.userId,
      organizationId: p.organizationId,
      resourceType: "ai_provider_credential",
      resourceId: linha.id,
      ...(p.requestId ? { requestId: p.requestId } : {}),
      metadata: { provider: PROVEDOR_DA_VOZ, label: ROTULO_DA_CHAVE_DE_VOZ, last4: linha.api_key_last4 },
    });
  }
  return removidas.length > 0;
}

export type ResultadoDoTeste = { ok: true; vozes: number } | { ok: false; erro: string };

/**
 * "Testar": lista as vozes com a chave da organização e grava o veredito na
 * linha (`validated_at` / `validation_error`), como o Revalidar das chaves de IA.
 * Devolve só o código — nunca a resposta do Google.
 */
export async function testarChaveDeVoz(
  admin: Admin,
  p: { organizationId: string; userId: string; requestId?: string; fetchImpl?: typeof fetch },
): Promise<ResultadoDoTeste | null> {
  const linha = await linhaDaVoz(admin, p.organizationId);
  if (!linha) return null;
  const chave = await lerChaveDaVoz(admin, p.organizationId);
  if (!chave || chave.origem !== "organizacao") return { ok: false, erro: "credencial_ilegivel" };

  const r = await validateGoogleTtsKey(chave.chave, p.fetchImpl ? { fetchImpl: p.fetchImpl } : {});
  await admin
    .from("ai_provider_credentials")
    .update(
      r.ok
        ? { validated_at: new Date().toISOString(), validation_error: null, models_available: r.models }
        : { validated_at: null, validation_error: r.error, models_available: null },
    )
    .eq("id", linha.id)
    .eq("organization_id", p.organizationId);

  await audit({
    action: "ai.credential_revalidated",
    actorUserId: p.userId,
    organizationId: p.organizationId,
    resourceType: "ai_provider_credential",
    resourceId: linha.id,
    ...(p.requestId ? { requestId: p.requestId } : {}),
    metadata: { provider: PROVEDOR_DA_VOZ, label: ROTULO_DA_CHAVE_DE_VOZ, ok: r.ok, error: r.ok ? null : r.error },
  });

  return r.ok ? { ok: true, vozes: r.models.length } : { ok: false, erro: r.error };
}
