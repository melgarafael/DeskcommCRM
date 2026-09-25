/**
 * GET  /api/v1/ai/rag-embedding — estado do embedding do RAG (provedor/modelo).
 * POST /api/v1/ai/rag-embedding — salva a chave (Google Gemini ou OpenAI) e
 *                                 amarra os pontos `embedding_indexar` e
 *                                 `embedding_consultar` a ela.
 *
 * ─── Por que existe ─────────────────────────────────────────────────────────
 * A base de conhecimento estava presa à OpenAI: o embedding só resolvia chave
 * OpenAI e os pontos eram `fixo` no registro — não havia superfície, na tela,
 * para o dono configurar a chave do RAG. Quem usa outro provedor (Gemini, via
 * Google AI Studio) ficava sem base e só descobria no log do contêiner.
 *
 * Aqui o dono escolhe o provedor e cola a chave. O miolo de cifrar/gravar é o
 * MESMO de `POST /api/v1/ai/credentials` (`guardarCredencial`); o que esta rota
 * acrescenta é AMARRAR os dois pontos de embedding à credencial recém-criada —
 * é isso que faz o runtime (indexação e busca) usar a chave escolhida.
 *
 * Trocar de provedor EXIGE reindexar: a busca casa o `embedding_model` gravado
 * na versão (migration 0181). A resposta do GET traz `precisa_reindexar` para a
 * tela avisar em vez de o dono achar que "não achou nada" é falta de material.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { guardarCredencial, validarEmSegundoPlano } from "@/lib/ai/credenciais/guardar";
import { bufToBytea, encryptKey } from "@/lib/crypto/aes_gcm";
import {
  MODELO_DE_EMBEDDING_POR_PROVEDOR,
  ehProvedorDeEmbedding,
  type ProvedorDeEmbedding,
} from "@/lib/ai/embeddings/chave";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const PONTOS_DE_EMBEDDING = ["embedding_indexar", "embedding_consultar"] as const;

const salvarSchema = z.object({
  provider: z.enum(["openai", "google"]),
  api_key: z.string().trim().min(8).max(2048),
  label: z.string().trim().min(1).max(80).optional(),
});

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "ai_embeddings" });
  if (!authz.ok) return authz.response;
  const { org } = authz;

  const admin = createAdminClient();
  const [bindingRes, credRes, versaoRes, fontesRes] = await Promise.all([
    admin
      .from("ai_purpose_bindings")
      .select("purpose, provider, credential_id, model_id, is_enabled")
      .eq("organization_id", org.orgId)
      .in("purpose", PONTOS_DE_EMBEDDING),
    admin
      .from("ai_provider_credentials_safe")
      .select("id, provider, label, api_key_last4, validated_at, validation_error, is_active")
      .eq("organization_id", org.orgId),
    admin
      .from("ai_knowledge_versions")
      .select("embedding_model")
      .eq("organization_id", org.orgId)
      .eq("status", "ready"),
    admin
      .from("ai_knowledge_sources")
      .select("last_index_status, status")
      .eq("organization_id", org.orgId),
  ]);

  const bindings = (bindingRes.data ?? []) as Array<{
    purpose: string;
    provider: string;
    credential_id: string | null;
    model_id: string;
    is_enabled: boolean;
  }>;
  const credenciais = (credRes.data ?? []) as Array<{
    id: string;
    provider: string;
    label: string;
    api_key_last4: string | null;
    validated_at: string | null;
    validation_error: string | null;
    is_active: boolean;
  }>;

  const consultar = bindings.find((b) => b.purpose === "embedding_consultar");
  const provedorAtivo =
    consultar && ehProvedorDeEmbedding(consultar.provider) ? consultar.provider : null;
  const modeloAtivo = provedorAtivo
    ? (consultar?.model_id ?? MODELO_DE_EMBEDDING_POR_PROVEDOR[provedorAtivo].model)
    : null;
  const credencialAtiva =
    consultar?.credential_id != null
      ? (credenciais.find((c) => c.id === consultar.credential_id) ?? null)
      : null;

  // Com que modelo o material foi indexado? Se divergir do modelo ativo, a busca
  // devolve vazio — e "base vazia" é indistinguível de "sem material" para quem
  // só vê o resultado. A tela mostra o aviso.
  const modelosIndexados = [
    ...new Set(versaoRes.data?.map((v) => (v as { embedding_model: string }).embedding_model) ?? []),
  ];
  const precisaReindexar =
    modelosIndexados.length > 0 && modeloAtivo !== null && !modelosIndexados.includes(modeloAtivo);

  // Estado da base: quantos materiais prontos / preparando / com erro. É o que
  // responde "está embedando? está tudo rodando?" sem o dono abrir log.
  const ativas = ((fontesRes.data ?? []) as Array<{
    last_index_status: string | null;
    status: string | null;
  }>).filter((f) => f.status !== "archived");
  const contar = (s: string) => ativas.filter((f) => f.last_index_status === s).length;
  const resumo = {
    total: ativas.length,
    prontos: contar("success"),
    preparando: contar("indexando"),
    com_erro: contar("failed"),
    parcial: contar("partial"),
    sem_credencial: contar("sem_credencial"),
  };

  return ok(
    {
      provider: provedorAtivo,
      model: modeloAtivo,
      credential: credencialAtiva
        ? {
            id: credencialAtiva.id,
            provider: credencialAtiva.provider,
            label: credencialAtiva.label,
            last4: credencialAtiva.api_key_last4,
            validated: credencialAtiva.validated_at !== null,
            validation_error: credencialAtiva.validation_error,
          }
        : null,
      modelos_indexados: modelosIndexados,
      precisa_reindexar: precisaReindexar,
      resumo,
    },
    { requestId },
  );
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "ai_embeddings" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;

  const limite = await checkRateLimit(`ai:rag-embedding:${org.orgId}`, 20, 60);
  if (!limite.allowed) {
    return fail("rate_limited", "Muitas alterações em pouco tempo. Tente de novo em instantes.", 429, {
      requestId,
    });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail("invalid_request", "Body JSON inválido.", 400, { requestId });
  }
  const parsed = salvarSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", "Campos inválidos.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const { provider, api_key, label } = parsed.data;
  if (!ehProvedorDeEmbedding(provider)) {
    return fail("validation_failed", "Provedor não faz embeddings.", 422, { requestId });
  }

  const admin = createAdminClient();

  // A credencial é opcionalmente reutilizada: se já existe uma ATIVA do mesmo
  // provedor, atualiza a chave dela em vez de criar outra (evita acúmulo de
  // chaves e o desempate ambíguo do resolvedor).
  const { data: existente } = await admin
    .from("ai_provider_credentials")
    .select("id")
    .eq("organization_id", org.orgId)
    .eq("provider", provider)
    .eq("is_active", true)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  let credentialId: string;
  if (existente?.id) {
    const encrypted = encryptKey(api_key);
    const { error } = await admin
      .from("ai_provider_credentials")
      .update({
        api_key_encrypted: bufToBytea(encrypted.ciphertext),
        api_key_iv: bufToBytea(encrypted.iv),
        api_key_tag: bufToBytea(encrypted.tag),
        api_key_last4: encrypted.last4,
        is_active: true,
        validated_at: null,
        validation_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existente.id)
      .eq("organization_id", org.orgId);
    if (error) {
      return fail("internal_error", "Não foi possível atualizar a chave.", 500, { requestId });
    }
    credentialId = existente.id;
    // Dispara a validação em segundo plano (mesma régua do POST de credentials).
    void validarEmSegundoPlano(admin, credentialId, org.orgId, provider, api_key);
  } else {
    const salvo = await guardarCredencial({
      admin,
      orgId: org.orgId,
      userId: user.id,
      provider,
      label: label ?? `Base de conhecimento — ${provider === "google" ? "Google Gemini" : "OpenAI"}`,
      apiKey: api_key,
      requestId,
    });
    if (!salvo.ok) {
      const motivo =
        salvo.motivo === "label_em_uso"
          ? "Já existe uma credencial com esse nome."
          : "Não foi possível guardar a chave.";
      return fail("internal_error", motivo, salvo.motivo === "label_em_uso" ? 409 : 500, {
        requestId,
      });
    }
    credentialId = salvo.id;
  }

  const modelo = MODELO_DE_EMBEDDING_POR_PROVEDOR[provider as ProvedorDeEmbedding].model;
  const { error: bindErr } = await admin.from("ai_purpose_bindings").upsert(
    PONTOS_DE_EMBEDDING.map((purpose) => ({
      organization_id: org.orgId,
      purpose,
      provider,
      credential_id: credentialId,
      model_id: modelo,
      base_url: null,
      is_enabled: true,
      updated_at: new Date().toISOString(),
    })),
    { onConflict: "organization_id,purpose" },
  );
  if (bindErr) {
    return fail("internal_error", "A chave foi guardada, mas não consegui ativá-la.", 500, {
      requestId,
    });
  }

  await audit({
    action: "ai.rag_embedding_updated",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "ai_provider_credential",
    resourceId: credentialId,
    requestId,
    metadata: { provider, model: modelo },
  });

  return ok({ provider, model: modelo, credential_id: credentialId }, { requestId });
}
