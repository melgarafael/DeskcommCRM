"use server";

/**
 * O aviso de mensagem nova sai na cor do canal, ou no neutro de sempre?
 * Escolha da EMPRESA inteira, em `settings.notificacoes.cor_por_canal` (#4094).
 *
 * Mesmo desenho de `definirConteudoNaTelaBloqueada`, e de propósito: as duas
 * opções moram no MESMO nó `notificacoes` do jsonb, então precisam da mesma
 * régua de permissão (admin, prova do segundo fator, admin client com o
 * `organization_id` de `resolveActiveOrg`, ler-mesclar-gravar para não apagar a
 * opção vizinha) e da mesma auditoria. Uma segunda forma de gravar o mesmo nó
 * é como um dos dois passa a apagar o outro.
 */
import { revalidatePath } from "next/cache";

import { audit } from "@/lib/audit";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { supportWriteError } from "@/lib/impersonate/support";
import { corPorCanalLigada } from "@/lib/schemas/settings";
import { createAdminClient } from "@/lib/supabase/admin";

import type { ErroTelaBloqueada } from "./definirConteudoNaTelaBloqueada";

/** Os mesmos códigos da opção vizinha: a tela já sabe traduzir todos. */
export type ErroCorPorCanal = ErroTelaBloqueada;

export type RespostaCorPorCanal =
  | { ok: true; valor: boolean; mudou: boolean }
  | { ok: false; erro: ErroCorPorCanal };

export async function definirCorPorCanal(valor: boolean): Promise<RespostaCorPorCanal> {
  // Server Action é endpoint público: o tipo do parâmetro não chega ao servidor.
  if (typeof valor !== "boolean") return { ok: false, erro: "invalido" };

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
  const anterior = corPorCanalLigada(settings);
  if (anterior === valor) return { ok: true, valor: anterior, mudou: false };

  const notificacoes = (settings.notificacoes ?? {}) as Record<string, unknown>;
  const novo = { ...settings, notificacoes: { ...notificacoes, cor_por_canal: valor } };
  const { error } = await admin.from("organizations").update({ settings: novo }).eq("id", org.orgId);
  if (error) return { ok: false, erro: "falha" };

  await audit({
    action: "notificacoes.cor_por_canal_alterada",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "organization",
    resourceId: org.orgId,
    metadata: { anterior, novo: valor },
  });

  revalidatePath("/app/settings/notifications");
  return { ok: true, valor, mudou: true };
}
