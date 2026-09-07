"use server";

/**
 * LIGAR E DESLIGAR A VERIFICAÇÃO EM DUAS ETAPAS — a da conta e a da empresa.
 *
 * O produto forçava TOTP para todo admin e não oferecia nem um nem outro: não
 * havia como ativar fora do bloqueador de tela cheia (o único ponto de enroll),
 * nem como desativar depois de ativado — `enrollMfa` só apaga fator
 * `unverified`, e os únicos caminhos que removiam um fator verificado eram o
 * código de recuperação e o suporte.
 *
 * Com o cadastro virando opcional, os dois caminhos passam a ser obrigatórios:
 * sem "ativar", a verificação fica INALCANÇÁVEL; sem "desativar", ligá-la é uma
 * porta sem volta.
 */
import { supportWriteError } from "@/lib/impersonate/support";
import { revalidatePath } from "next/cache";

import { audit } from "@/lib/audit";
import { loadAuthUser, resolveActiveOrg, sessionAal, isMfaEnrolled } from "@/lib/auth/server";
import { empresaExigeMfa, exigeCadastroDeMfa } from "@/lib/auth/politica-mfa";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export type ResultadoDaPolitica = { ok: true } | { ok: false; erro: string };

/**
 * A empresa passa a exigir (ou deixa de exigir) a verificação dos seus
 * administradores.
 *
 * ⚠️ SERVICE ROLE COM `organization_id` DE FONTE CONFIÁVEL. A única policy de
 * escrita em `organizations` é `orgs_write_platform_admin`: pelo client de
 * sessão, o UPDATE de um admin de tenant casa ZERO linhas e devolve sucesso — a
 * tela diria "salvo" sobre nada. O id vem de `resolveActiveOrg`, nunca do corpo.
 */
export async function definirExigenciaDeMfa(exigir: boolean): Promise<ResultadoDaPolitica> {
  const user = await loadAuthUser();
  if (!user) return { ok: false, erro: "Sua sessão expirou. Entre de novo." };
  if (supportWriteError(user.support)) return { ok: false, erro: "Acompanhamento somente leitura ou encerrado." };
  const org = await resolveActiveOrg(user);
  if (!org) return { ok: false, erro: "Nenhuma empresa ativa." };

  if (org.role !== "admin") {
    return { ok: false, erro: "Só um administrador pode mudar essa regra." };
  }

  const admin = createAdminClient();
  const { data: atual, error: erroLeitura } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", org.orgId)
    .maybeSingle();
  if (erroLeitura) return { ok: false, erro: "Não consegui ler a configuração agora." };

  // `settings` é jsonb livre e compartilhado (o provedor de IA mora nele): ler,
  // mesclar e gravar preserva o que não é nosso. Um UPDATE com o objeto montado
  // do zero apagaria a escolha de IA da instalação.
  const settings = (atual?.settings ?? {}) as Record<string, unknown>;
  const security = (settings.security ?? {}) as Record<string, unknown>;
  const novo = { ...settings, security: { ...security, mfa_required: exigir } };

  const { error } = await admin.from("organizations").update({ settings: novo }).eq("id", org.orgId);
  if (error) return { ok: false, erro: "Não consegui salvar essa mudança agora." };

  await audit({
    action: exigir ? "security.mfa_exigida" : "security.mfa_dispensada",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "organization",
    resourceId: org.orgId,
  });

  // O gate mora no layout do app, que é servidor: sem invalidar, a mudança só
  // apareceria no próximo recarregamento completo.
  revalidatePath("/app", "layout");
  return { ok: true };
}

/**
 * Desliga a verificação da PRÓPRIA conta, removendo os fatores.
 *
 * ⚠️ EXIGE TER PROVADO O FATOR NESTA SESSÃO (`aal2`). Sem isso, uma sessão
 * roubada — que é exatamente o cenário que a verificação em duas etapas existe
 * para conter — desligaria a proteção com um clique. É a mesma razão pela qual
 * trocar senha pede a senha atual.
 *
 * ⚠️ E RECUSA QUANDO A POLÍTICA OBRIGA. Deixar desligar o que a empresa (ou a
 * plataforma) exige devolveria a pessoa ao bloqueador de tela cheia no próximo
 * carregamento — um botão cujo efeito é ser desfeito.
 */
export async function desativarMfaDaConta(): Promise<ResultadoDaPolitica> {
  const user = await loadAuthUser();
  if (!user) return { ok: false, erro: "Sua sessão expirou. Entre de novo." };
  if (supportWriteError(user.support)) return { ok: false, erro: "Acompanhamento somente leitura ou encerrado." };
  const org = await resolveActiveOrg(user);

  if (!(await isMfaEnrolled())) return { ok: true };

  const admin = createAdminClient();

  let plataformaExige: boolean | null = null;
  if (user.is_platform_admin) {
    const { data } = await admin
      .from("platform_admins")
      .select("mfa_required")
      .eq("user_id", user.id)
      .is("revoked_at", null)
      .maybeSingle();
    plataformaExige = (data?.mfa_required as boolean | undefined) ?? null;
  }

  let empresaExige = false;
  if (org) {
    const { data } = await admin
      .from("organizations")
      .select("settings")
      .eq("id", org.orgId)
      .maybeSingle();
    empresaExige = empresaExigeMfa(data?.settings);
  }

  if (
    exigeCadastroDeMfa({
      role: org?.role,
      isPlatformAdmin: user.is_platform_admin,
      plataformaExige,
      empresaExige,
    })
  ) {
    return {
      ok: false,
      erro: "A verificação em duas etapas é obrigatória para administradores desta empresa. Desligue a regra antes.",
    };
  }

  if ((await sessionAal()) !== "aal2") {
    return {
      ok: false,
      erro: "Entre de novo e informe o código de 6 dígitos antes de desligar a verificação.",
    };
  }

  const supabase = await createClient();
  const { data: fatores } = await supabase.auth.mfa.listFactors();
  for (const f of fatores?.all ?? []) {
    if (f.factor_type !== "totp") continue;
    const { error } = await supabase.auth.mfa.unenroll({ factorId: f.id });
    if (error) return { ok: false, erro: "Não consegui remover a verificação agora." };
  }

  await audit({
    action: "security.mfa_desativada",
    actorUserId: user.id,
    organizationId: org?.orgId ?? null,
    resourceType: "user",
    resourceId: user.id,
  });

  revalidatePath("/app", "layout");
  return { ok: true };
}
