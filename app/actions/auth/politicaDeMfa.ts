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
import { loadAuthUser, resolveActiveOrg, sessionAal, isMfaEnrolled, mfaEmDivida } from "@/lib/auth/server";
import {
  empresaExigeMfa,
  exigeCadastroDeMfa,
  papelMinimoValido,
  politicaDaEmpresa,
  type PapelMinimoDeMfa,
} from "@/lib/auth/politica-mfa";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export type ResultadoDaPolitica = { ok: true } | { ok: false; erro: string };

/** O que a tela de Segurança envia: o nível mínimo e a carência, juntos. */
export interface AlvoDaPoliticaDeMfa {
  minRole: PapelMinimoDeMfa;
  /** 0..30 dias. `0` = bloqueio imediato, que é o comportamento de hoje. */
  graceDays: number;
}

/**
 * A empresa passa a exigir (ou deixa de exigir) a verificação — de QUEM, e com
 * QUANTOS DIAS de carência (#1533).
 *
 * As três chaves novas moram no MESMO `settings.security` jsonb que já guarda
 * `mfa_required`, e o booleano continua sendo escrito junto: `mfa_required` é o
 * que a leitura legada enxerga, e ele tem que continuar dizendo a verdade
 * (`true` = alguém é cobrado). A carência é ancorada por
 * `mfa_policy_changed_at`, que só é gravado AQUI, quando a política muda de
 * verdade — regravar o mesmo valor reiniciaria o prazo de todo mundo sem que
 * ninguém tenha mudado nada.
 *
 * ⚠️ SERVICE ROLE COM `organization_id` DE FONTE CONFIÁVEL. A única policy de
 * escrita em `organizations` é `orgs_write_platform_admin`: pelo client de
 * sessão, o UPDATE de um admin de tenant casa ZERO linhas e devolve sucesso — a
 * tela diria "salvo" sobre nada. O id vem de `resolveActiveOrg`, nunca do corpo.
 */
export async function definirExigenciaDeMfa(
  alvo: AlvoDaPoliticaDeMfa | boolean,
): Promise<ResultadoDaPolitica> {
  const user = await loadAuthUser();
  if (!user) return { ok: false, erro: "Sua sessão expirou. Entre de novo." };
  if (supportWriteError(user.support)) return { ok: false, erro: "Acompanhamento somente leitura ou encerrado." };
  const org = await resolveActiveOrg(user);
  if (!org) return { ok: false, erro: "Nenhuma empresa ativa." };

  if (org.role !== "admin") {
    return { ok: false, erro: "Só um administrador pode mudar essa regra." };
  }
  // Depois do papel: só quem passaria por ele é cobrado pelo segundo fator. A
  // regra da empresa inteira é escrita tão sensível quanto desligar o próprio
  // fator — quem TEM fator prova nesta sessão, como nas rotas (`requireRole`).
  if (await mfaEmDivida()) {
    return { ok: false, erro: "Confirme a verificação em duas etapas nesta sessão." };
  }

  // `boolean` ainda é aceito: é a assinatura antiga desta mesma ação, e a
  // leitura legada (`mfa_required` sem `min_role`) significa exatamente ele —
  // `true` vira "só dos administradores".
  const corpo = typeof alvo === "object" && alvo !== null ? alvo : null;
  if (corpo === null && typeof alvo !== "boolean") return { ok: false, erro: "Papel mínimo inválido." };
  const minRole = corpo ? papelMinimoValido(corpo.minRole) : alvo === true ? "admin" : "none";
  if (minRole === null) return { ok: false, erro: "Papel mínimo inválido." };
  const graceDays = corpo ? corpo.graceDays : 0;
  if (!Number.isInteger(graceDays) || graceDays < 0 || graceDays > 30) {
    return { ok: false, erro: "Período de carência inválido: use de 0 a 30 dias." };
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

  // O valor atual é resolvido como a REGRA resolve: a chave nova, e na falta
  // dela o booleano legado (ausente = `none`). Sem isto, "não mudou nada" seria
  // mentira para toda organização que só tem `mfa_required`.
  const cfg = politicaDaEmpresa(settings);
  const papelAtual = cfg.papelMinimo ?? (empresaExigeMfa(settings) ? "admin" : "none");
  if (papelAtual === minRole && cfg.diasDeCarencia === graceDays) {
    // Nada mudou: sem escrita e sem auditoria. Uma linha de audit dizendo que a
    // política "mudou" para o mesmo valor é ruído que ensina quem lê a desconfiar
    // do log — e regravar `mfa_policy_changed_at` aqui reiniciaria a carência.
    return { ok: true };
  }

  const novo = {
    ...settings,
    security: {
      ...security,
      mfa_required: minRole !== "none",
      mfa_required_min_role: minRole,
      mfa_grace_days: graceDays,
      mfa_policy_changed_at: new Date().toISOString(),
    },
  };

  const { error } = await admin.from("organizations").update({ settings: novo }).eq("id", org.orgId);
  if (error) return { ok: false, erro: "Não consegui salvar essa mudança agora." };

  // A troca fica auditada com o valor ANTERIOR e o NOVO — o critério de aceite
  // da issue. O código de ação continua sendo o de sempre (exigida/dispensada),
  // porque é ele que o painel de auditoria já filtra.
  await audit({
    action: minRole !== "none" ? "security.mfa_exigida" : "security.mfa_dispensada",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "organization",
    resourceId: org.orgId,
    metadata: {
      papel_minimo_anterior: papelAtual,
      papel_minimo_novo: minRole,
      dias_de_carencia_anterior: cfg.diasDeCarencia,
      dias_de_carencia_novo: graceDays,
    },
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
  let papelMinimo: PapelMinimoDeMfa | null = null;
  if (org) {
    const { data } = await admin
      .from("organizations")
      .select("settings")
      .eq("id", org.orgId)
      .maybeSingle();
    empresaExige = empresaExigeMfa(data?.settings);
    // A mesma regra nova do gate: com `mfa_required_min_role`, um atendente já
    // está obrigado, e obrigado não desliga o próprio fator — senão a carência
    // viraria a janela em que alguém escapa do bloqueio.
    papelMinimo = politicaDaEmpresa(data?.settings).papelMinimo;
  }

  if (
    exigeCadastroDeMfa({
      role: org?.role,
      isPlatformAdmin: user.is_platform_admin,
      plataformaExige,
      empresaExige,
      papelMinimo,
    })
  ) {
    return {
      ok: false,
      erro: "A verificação em duas etapas é obrigatória para você nesta empresa. Desligue a regra antes.",
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
