/**
 * Cadastra credenciais BYO de provedor LLM (`ai_provider_credentials`) a partir
 * das chaves já presentes no ambiente — mesmo caminho de código que a tela
 * `/app/ai/credentials` usa no `POST /api/v1/ai/credentials`: cifra AES-GCM,
 * grava só o `last4` em claro, valida contra o provedor e emite audit log.
 *
 * Por que existe: a tela exige login com senha + MFA TOTP. Num self-host recém
 * instalado (ou num ambiente de dev sem acesso ao autenticador) não há como
 * chegar nela, e sem credential o agente do CRM não roda — ele NÃO usa
 * `ANTHROPIC_API_KEY` do env, e sim a credential por organização.
 *
 * Idempotente: `(organization_id, provider, label)` é único; label já existente
 * é pulado, nunca sobrescrito — rotação de chave é ato consciente na tela.
 *
 * Uso (o `--env-file` não é opcional: `lib/crypto/aes_gcm` importa `lib/env`,
 * que valida o ambiente do PROCESSO):
 *   pnpm exec tsx --env-file=.env.local scripts/register-ai-credentials.ts \
 *     [--org <uuid>] [--label "Padrão"]
 *
 * Lê ANTHROPIC_API_KEY e OPENAI_API_KEY do ambiente. Ausente = provider pulado.
 */
import { bufToBytea, encryptKey } from "@/lib/crypto/aes_gcm";
import { validateProviderKey, type Provider } from "@/lib/ai/provider-validators";
import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";

const args = process.argv.slice(2);
function arg(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

const LABEL = arg("label") ?? "Padrão";

const SOURCES: { provider: Provider; envVar: string }[] = [
  { provider: "anthropic", envVar: "ANTHROPIC_API_KEY" },
  { provider: "openai", envVar: "OPENAI_API_KEY" },
];

async function main(): Promise<void> {
  const admin = createAdminClient();

  let orgId = arg("org");
  if (!orgId) {
    const { data: orgs, error } = await admin.from("organizations").select("id, legal_name");
    if (error) throw new Error(`Falha ao listar organizations: ${error.message}`);
    if (!orgs || orgs.length === 0) throw new Error("Nenhuma organization no banco.");
    if (orgs.length > 1) {
      throw new Error(
        `Mais de uma organization — passe --org <uuid>:\n` +
          orgs.map((o) => `  ${o.id}  ${o.legal_name}`).join("\n"),
      );
    }
    orgId = orgs[0]!.id;
    console.info(`org: ${orgs[0]!.legal_name} (${orgId})`);
  }

  // `created_by` espelha quem criaria pela tela: um admin da org.
  const { data: adminMember } = await admin
    .from("user_organizations")
    .select("user_id")
    .eq("organization_id", orgId)
    .eq("role", "admin")
    .limit(1)
    .maybeSingle();
  const actorUserId = adminMember?.user_id ?? null;

  for (const { provider, envVar } of SOURCES) {
    const apiKey = process.env[envVar]?.trim();
    if (!apiKey) {
      console.info(`${provider}: ${envVar} vazia — pulado.`);
      continue;
    }

    const { data: existing } = await admin
      .from("ai_provider_credentials")
      .select("id, api_key_last4")
      .eq("organization_id", orgId)
      .eq("provider", provider)
      .eq("label", LABEL)
      .maybeSingle();
    if (existing) {
      console.info(
        `${provider}: já existe credential "${LABEL}" (…${existing.api_key_last4}) — pulado.`,
      );
      continue;
    }

    const encrypted = encryptKey(apiKey);
    const { data: created, error: insErr } = await admin
      .from("ai_provider_credentials")
      .insert({
        organization_id: orgId,
        provider,
        label: LABEL,
        api_key_encrypted: bufToBytea(encrypted.ciphertext),
        api_key_iv: bufToBytea(encrypted.iv),
        api_key_tag: bufToBytea(encrypted.tag),
        api_key_last4: encrypted.last4,
        is_active: true,
        created_by: actorUserId,
      })
      .select("id")
      .single();
    if (insErr || !created) {
      throw new Error(`${provider}: falha ao inserir — ${insErr?.message}`);
    }

    await audit({
      action: "ai.credential_created",
      actorUserId,
      organizationId: orgId,
      resourceType: "ai_provider_credential",
      resourceId: created.id,
      metadata: { provider, label: LABEL, last4: encrypted.last4, source: "script" },
    });

    // Mesma validação da tela — porém síncrona, pra o script poder reportar.
    const result = await validateProviderKey(provider, apiKey);
    const patch = result.ok
      ? {
          validated_at: new Date().toISOString(),
          validation_error: null,
          models_available: result.models,
        }
      : { validated_at: null, validation_error: result.error };
    const { error: upErr } = await admin
      .from("ai_provider_credentials")
      .update(patch)
      .eq("id", created.id)
      .eq("organization_id", orgId);
    if (upErr) console.error(`${provider}: falha ao persistir validação — ${upErr.message}`);

    console.info(
      result.ok
        ? `${provider}: criada (…${encrypted.last4}) — validada, ${result.models.length} modelos.`
        : `${provider}: criada (…${encrypted.last4}) — validação FALHOU: ${result.error}`,
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
