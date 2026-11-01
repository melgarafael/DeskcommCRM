"use server";

/**
 * O que os avisos do celular mostram com a tela bloqueada, para a EMPRESA
 * inteira (`settings.notificacoes.conteudo_na_tela_bloqueada`; schema e padrão
 * em `lib/schemas/settings.ts`).
 *
 * Mesmo desenho de `definirExigenciaDeMfa` (`app/actions/auth/politicaDeMfa.ts`):
 * só admin, prova do segundo fator quando existe, admin client com o
 * `organization_id` de `resolveActiveOrg` (pela sessão, o UPDATE de um admin de
 * tenant em `organizations` casa zero linhas e devolve sucesso), ler-mesclar-
 * gravar para preservar o resto do jsonb, e auditoria só quando muda.
 */
import { revalidatePath } from "next/cache";

import { audit } from "@/lib/audit";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { supportWriteError } from "@/lib/impersonate/support";
import {
  conteudoNaTelaBloqueada,
  conteudoNaTelaBloqueadaWriteSchema,
  type ConteudoNaTelaBloqueada,
} from "@/lib/schemas/settings";
import { createAdminClient } from "@/lib/supabase/admin";

/** Códigos, e não frases: a tela traduz. */
export type ErroTelaBloqueada =
  | "invalido"
  | "sessao"
  | "somente_leitura"
  | "sem_empresa"
  | "sem_permissao"
  | "mfa"
  | "falha";

export type RespostaTelaBloqueada =
  | { ok: true; valor: ConteudoNaTelaBloqueada; mudou: boolean }
  | { ok: false; erro: ErroTelaBloqueada };

export async function definirConteudoNaTelaBloqueada(valor: ConteudoNaTelaBloqueada): Promise<RespostaTelaBloqueada> {
  // Server Action é endpoint público: o tipo do parâmetro não chega ao servidor.
  const entrada = conteudoNaTelaBloqueadaWriteSchema.safeParse(valor);
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
  const anterior = conteudoNaTelaBloqueada(settings);
  if (anterior === entrada.data) return { ok: true, valor: anterior, mudou: false };

  const notificacoes = (settings.notificacoes ?? {}) as Record<string, unknown>;
  const novo = { ...settings, notificacoes: { ...notificacoes, conteudo_na_tela_bloqueada: entrada.data } };
  const { error } = await admin.from("organizations").update({ settings: novo }).eq("id", org.orgId);
  if (error) return { ok: false, erro: "falha" };

  await audit({
    action: "notificacoes.tela_bloqueada_alterada",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "organization",
    resourceId: org.orgId,
    metadata: { anterior, novo: entrada.data },
  });

  revalidatePath("/app/settings/notifications");
  return { ok: true, valor: entrada.data, mudou: true };
}
