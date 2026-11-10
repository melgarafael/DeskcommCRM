"use server";

/**
 * GRAVA A LISTA DE ETIQUETAS DE CONTATO DA EQUIPE (#3534).
 *
 * Contato com uma dessas etiquetas CONTINUA sendo atendido pela IA e segue
 * normal na Inbox; o que ele não tem é repasse automático por clima (o sócio
 * que testa o agente não é "cliente irritado" e não pode ser silenciado). Também
 * não vira card no funil. O que a lista decide está no cabeçalho de
 * `lib/contacts/tags-da-equipe.ts`.
 *
 * ── Por que `manager`, e por que SERVICE ROLE ───────────────────────────────
 *
 * As mesmas do irmão `definirTagsDeContatoInterno` (#2353): a tela é
 * Configurações → Tags, cujo piso é `manager`; e pelo client de sessão um
 * Gerente de tenant casa ZERO linhas em `organizations` (a única policy de
 * escrita é `orgs_write_platform_admin`), devolvendo sucesso sem gravar. O id
 * vem de `resolveActiveOrg`, nunca de argumento.
 *
 * ── Por que não há migration ────────────────────────────────────────────────
 *
 * `settings` é jsonb e a linha já existe: a lista mora em
 * `organizations.settings.crm.team_contact_tags`, ao lado da interna, e o
 * UPDATE mescla o resto do jsonb intacto.
 */
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { normalizarTags, TAMANHO_MAXIMO_DA_TAG } from "@/lib/contacts/tag-normalizada";
import { supportWriteError } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

/** Teto da lista — o mesmo da lista interna. */
const TETO_DE_TAGS = 50;

const entradaSchema = z.object({
  tags: z.array(z.string().max(TAMANHO_MAXIMO_DA_TAG)).max(TETO_DE_TAGS),
});

export type ResultadoTagsDaEquipe =
  | { ok: true; tags: string[] }
  | {
      ok: false;
      error:
        | "validation_failed"
        | "unauthenticated"
        | "forbidden_tenant"
        | "forbidden_role"
        | "mfa_required"
        | "erro_ao_gravar";
    };

export async function definirTagsDaEquipe(
  input: z.infer<typeof entradaSchema>,
): Promise<ResultadoTagsDaEquipe> {
  // Server Action é endpoint público: o tipo do parâmetro não chega ao servidor.
  const entrada = entradaSchema.safeParse(input);
  if (!entrada.success) return { ok: false, error: "validation_failed" };

  const user = await loadAuthUser();
  if (!user) return { ok: false, error: "unauthenticated" };
  if (supportWriteError(user.support)) return { ok: false, error: "forbidden_role" };
  const org = await resolveActiveOrg(user);
  if (!org) return { ok: false, error: "forbidden_tenant" };
  // Mesmo piso da tela de Tags.
  if (ROLE_RANK[org.role] < ROLE_RANK.manager) return { ok: false, error: "forbidden_role" };
  if (await mfaEmDivida()) return { ok: false, error: "mfa_required" };

  // Normaliza na escrita pela MESMA régua do banco: duplicata e caixa mista não
  // entram, e a lista lida bate byte a byte com a lista gravada.
  const tags = normalizarTags(entrada.data.tags);

  const admin = createAdminClient();
  const { data: atual, error: erroLeitura } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", org.orgId)
    .maybeSingle();
  if (erroLeitura) {
    logger.error("[tags-da-equipe] leitura da organização falhou", {
      organization_id: org.orgId,
      code: erroLeitura.code,
      error: erroLeitura.message,
    });
    return { ok: false, error: "erro_ao_gravar" };
  }

  // `settings` é jsonb compartilhado: ler, mesclar e gravar preserva o que não é nosso.
  const settings = (atual?.settings ?? {}) as Record<string, unknown>;
  const crm = (settings.crm ?? {}) as Record<string, unknown>;
  const novo = { ...settings, crm: { ...crm, team_contact_tags: tags } };

  const { error } = await admin.from("organizations").update({ settings: novo }).eq("id", org.orgId);
  if (error) {
    logger.error("[tags-da-equipe] gravação falhou", {
      organization_id: org.orgId,
      code: error.code,
      error: error.message,
    });
    return { ok: false, error: "erro_ao_gravar" };
  }

  await audit({
    action: "crm.tags_da_equipe_alteradas",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "organization",
    resourceId: org.orgId,
    metadata: { tags, quantidade: tags.length },
  });

  // A tela lê a lista do settings no render do servidor: sem revalidar, a
  // mudança só apareceria no próximo recarregamento completo.
  revalidatePath("/app/settings/tags");
  return { ok: true, tags };
}
