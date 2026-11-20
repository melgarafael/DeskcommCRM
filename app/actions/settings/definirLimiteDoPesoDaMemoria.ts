"use server";

/**
 * O limite em tokens acima do qual a tela Memória da IA avisa que a memória
 * pesa, para a EMPRESA inteira (`settings.memoria_da_ia.limite_do_aviso_tokens`;
 * schema, faixa e o recomendado em `lib/schemas/settings.ts`). O aviso só
 * informa: este número não bloqueia nem corta nada.
 *
 * Mesmo desenho de `definirConteudoNaTelaBloqueada`: só admin (o mesmo papel
 * que publica a memória, `requireRole("admin")` em `app/api/v1/ai/memory`),
 * prova do segundo fator quando existe, admin client com o `organization_id`
 * de `resolveActiveOrg` (pela sessão, o UPDATE de um admin de tenant em
 * `organizations` casa zero linhas e devolve sucesso), ler-mesclar-gravar para
 * preservar o resto do jsonb, e auditoria só quando muda.
 */
import { revalidatePath } from "next/cache";

import { audit } from "@/lib/audit";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { supportWriteError } from "@/lib/impersonate/support";
import { limiteDoPesoDaMemoria, limiteDoPesoDaMemoriaWriteSchema } from "@/lib/schemas/settings";
import { createAdminClient } from "@/lib/supabase/admin";

/** Códigos, e não frases: a tela traduz. */
export type ErroLimiteDoPeso =
  | "invalido"
  | "sessao"
  | "somente_leitura"
  | "sem_empresa"
  | "sem_permissao"
  | "mfa"
  | "falha";

export type RespostaLimiteDoPeso =
  | { ok: true; valor: number; mudou: boolean }
  | { ok: false; erro: ErroLimiteDoPeso };

export async function definirLimiteDoPesoDaMemoria(valor: number): Promise<RespostaLimiteDoPeso> {
  // Server Action é endpoint público: o tipo do parâmetro não chega ao servidor.
  const entrada = limiteDoPesoDaMemoriaWriteSchema.safeParse(valor);
  if (!entrada.success) return { ok: false, erro: "invalido" };

  const user = await loadAuthUser();
  if (!user) return { ok: false, erro: "sessao" };
  if (supportWriteError(user.support)) return { ok: false, erro: "somente_leitura" };
  const org = await resolveActiveOrg(user);
  if (!org) return { ok: false, erro: "sem_empresa" };
  if (org.role !== "admin") return { ok: false, erro: "sem_permissao" };
  if (await mfaEmDivida()) return { ok: false, erro: "mfa" };

  const admin = createAdminClient();
  const { data: atual, error: erroLeitura } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", org.orgId)
    .maybeSingle();
  if (erroLeitura) return { ok: false, erro: "falha" };

  const settings = (atual?.settings ?? {}) as Record<string, unknown>;
  const anterior = limiteDoPesoDaMemoria(settings);
  if (anterior === entrada.data) return { ok: true, valor: anterior, mudou: false };

  const memoria = (settings.memoria_da_ia ?? {}) as Record<string, unknown>;
  const novo = { ...settings, memoria_da_ia: { ...memoria, limite_do_aviso_tokens: entrada.data } };
  const { error } = await admin.from("organizations").update({ settings: novo }).eq("id", org.orgId);
  if (error) return { ok: false, erro: "falha" };

  await audit({
    action: "ai.org_memory_weight_limit_updated",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "organization",
    resourceId: org.orgId,
    metadata: { anterior, novo: entrada.data },
  });

  revalidatePath("/app/ai/memory");
  return { ok: true, valor: entrada.data, mudou: true };
}
