/**
 * Helper ÚNICO de autorização por role nas rotas /api/v1 (spec 13 §4 — G2-01).
 *
 * Resolve o role efetivo do usuário na org ativa e nega com 403 padronizado
 * (`fail("forbidden_role", ...)`). Nenhuma rota deve reimplementar a checagem
 * na mão (comparação com ROLE_RANK direto em rota é proibida — anti-padrão
 * "matriz advisória").
 *
 * Fluxo:
 *  1. `loadAuthUser()` — valida o JWT via `supabase.auth.getUser()` (nunca
 *     `getSession()`); 401 se não autenticado.
 *  2. `orgAtivaSemPortao()` — org ativa de fonte confiável (cookie validado
 *     contra memberships), NUNCA do body; 403 `forbidden_tenant` se ausente.
 *     SEM o portão de `resolveActiveOrg`: aquele REDIRECIONA a org suspensa, e
 *     rota de API responde 403 JSON, não 307 HTML.
 *  3. Org não operante (`lib/organizacao/operante.ts`) → 403 `org_suspended`,
 *     salvo `permiteOrgSuspensa` (só LGPD e cobrança — cerca
 *     `tests/unit/org-suspensa-so-nas-rotas-permitidas.test.ts`).
 *  4. Atalho de platform admin: `"leitura"` libera qualquer scope; `true` só
 *     `scope === 'full'` sem dívida de MFA.
 *  5. `rpc fn_user_role_in_org(org)` — role efetivo direto do banco, a MESMA
 *     função SECURITY DEFINER que as policies RLS usam; falha fechada se o
 *     membership foi revogado.
 *  6. Rank insuficiente → audit `authz.denied` (fire-and-forget) + 403.
 */
import type { NextResponse } from "next/server";

import { fail, type ApiError } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { loadAuthUser, mfaEmDivida, orgAtivaSemPortao } from "@/lib/auth/server";
import { ROLE_RANK, type ActiveOrg, type AuthUser, type Role } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { STATUS_OPERANTE, ehOperante } from "@/lib/organizacao/operante";
import { createClient } from "@/lib/supabase/server";

export type RoleCheck =
  | { ok: true; user: AuthUser; org: ActiveOrg }
  | { ok: false; response: NextResponse<ApiError> };

const MENSAGEM_DE_MFA =
  "Esta sessão precisa da verificação em duas etapas. Entre novamente com o código do aplicativo.";

interface RequireRoleOpts {
  /** Correlaciona a resposta e o audit com o X-Request-Id da rota. */
  requestId?: string;
  /** resource_type gravado no audit `authz.denied` (ex.: "api_tokens"). */
  resource?: string;
  /**
   * Platform admin (role transversal) bypassa o rank do tenant.
   * - `true`: rota que ESCREVE — só `scope === 'full'` e sessão sem dívida de
   *   MFA; `support_readonly` cai no rank normal do tenant.
   * - `"leitura"`: qualquer scope. Só em handler `GET` exportado — `requireRole`
   *   não recebe o método, e quem garante isso é
   *   `tests/unit/admin-escrita-exige-scope-full.test.ts`.
   */
  allowPlatformAdmin?: boolean | "leitura";
  /**
   * Override da org onde o role é resolvido (default: org ativa do cookie).
   * Use quando a autorização é sobre a org do RECURSO (ex.: LGPD anonymize —
   * admin na org do CONTATO), resolvida de fonte confiável (query RLS-scoped),
   * NUNCA do body. O role vem de `fn_user_role_in_org(p_org)` nessa org.
   */
  organizationId?: string;
  /** Deixa passar org NÃO operante. Só rotas de LGPD e de cobrança. */
  permiteOrgSuspensa?: boolean;
}

/** O 403 da org não operante — o MESMO em `requireRole` e em `orgAtivaDaApi`. */
function orgSuspensa(user: AuthUser, requestId?: string): NextResponse<ApiError> {
  return fail("org_suspended", traduzir("A conta desta empresa está suspensa.", user.idioma), 403, {
    requestId,
  });
}

export type OrgDaApi =
  | { ok: true; org: ActiveOrg | null }
  | { ok: false; response: NextResponse<ApiError> };

/**
 * A org ativa para Route Handler que não passa por `requireRole` (rotas que
 * escolhem o próprio 401/403 de "sem org"). Org não operante → 403
 * `org_suspended` em JSON, e o cliente (lib/api/client.ts) leva a janela ao hub.
 *
 * NÃO use `resolveActiveOrg` em `app/api/**`: ele REDIRECIONA, o `fetch` segue
 * o 307 e entrega o HTML de `/account-suspended` à tela como se fosse o dado
 * (cerca `tests/unit/api-nao-redireciona-org-suspensa.test.ts`).
 * Sem usuário, sem org: `{ ok: true, org: null }`, e a rota responde o seu "sem org".
 */
export async function orgAtivaDaApi(user: AuthUser | null, requestId?: string): Promise<OrgDaApi> {
  const org = user ? await orgAtivaSemPortao(user) : null;
  if (user && org && !ehOperante(org.org_status)) {
    return { ok: false, response: orgSuspensa(user, requestId) };
  }
  return { ok: true, org };
}

/**
 * Gate de rota: `const authz = await requireRole("manager", { requestId });`
 * `if (!authz.ok) return authz.response;`
 */
export async function requireRole(min: Role, opts: RequireRoleOpts = {}): Promise<RoleCheck> {
  const {
    requestId,
    resource,
    allowPlatformAdmin = false,
    organizationId,
    permiteOrgSuspensa = false,
  } = opts;

  const user = await loadAuthUser();
  if (!user) {
    return { ok: false, response: fail("unauthenticated", "Auth required.", 401, { requestId }) };
  }
  const t = (texto: string) => traduzir(texto, user.idioma);

  if (user.support && user.support.status !== "active") {
    return { ok: false, response: fail("forbidden", "O acompanhamento terminou. Saia para continuar.", 403, { requestId }) };
  }
  let org: ActiveOrg | null;
  if (organizationId) {
    const membership = user.organizations.find((o) => o.organization_id === organizationId);
    org = user.support?.organization_id === organizationId
      ? {
          orgId: organizationId,
          name: user.support.name,
          role: user.support.access_mode === "full" ? "admin" : "viewer",
          // `fn_support_context` só dá 'active' com a org em 'active' (e o
          // acompanhamento encerrado já saiu acima).
          org_status: STATUS_OPERANTE,
        }
      : membership
      ? {
          orgId: membership.organization_id,
          name: membership.organization_name,
          role: membership.role,
          org_status: membership.org_status ?? null,
          suspended_kind: membership.suspended_kind ?? null,
        }
      : allowPlatformAdmin !== false && user.is_platform_admin
        // Sem membership o status é desconhecido: `null` falha fechado. Hoje o
        // único chamador (LGPD anonymize) passa `permiteOrgSuspensa`.
        ? { orgId: organizationId, name: "—", role: "viewer", org_status: null }
        : null;
  } else {
    org = await orgAtivaSemPortao(user);
  }
  if (!org) {
    return {
      ok: false,
      response: fail("forbidden_tenant", t("Sem organização ativa."), 403, { requestId }),
    };
  }

  // ANTES do atalho de platform admin: nada que custe ou saia roda em org
  // parada, nem pelas mãos do dono da instalação.
  if (!permiteOrgSuspensa && !ehOperante(org.org_status)) {
    return { ok: false, response: orgSuspensa(user, requestId) };
  }

  if (user.is_platform_admin && !user.support && allowPlatformAdmin !== false) {
    if (allowPlatformAdmin === "leitura") return { ok: true, user, org };
    if (user.platform_admin_scope === "full") {
      if (await mfaEmDivida()) {
        void audit({
          action: "authz.denied",
          actorUserId: user.id,
          organizationId: org.orgId,
          resourceType: resource ?? null,
          requestId,
          metadata: { reason: "mfa_required", via: "platform_admin" },
        });
        return { ok: false, response: fail("mfa_required", t(MENSAGEM_DE_MFA), 403, { requestId }) };
      }
      return { ok: true, user, org };
    }
    // `support_readonly` com `true`: sem atalho — segue para o rank do tenant.
  }

  // Role efetivo do banco (não do snapshot do cookie/membership em memória).
  const supabase = await createClient();
  // Duas leituras independentes da mesma requisição: não somar a espera de
  // permissões com a de MFA em cada botão/consulta. Nenhuma decisão é cacheada.
  // Capturar a rejeição mantém a precedência: papel insuficiente continua 403,
  // e uma falha de MFA só é propagada quando essa checagem seria necessária.
  const mfaPendente = mfaEmDivida().then(
    (required) => ({ required }),
    (error: unknown) => ({ error }),
  );
  const { data: effectiveRole, error } = await supabase.rpc("fn_user_role_in_org", {
    p_org: org.orgId,
  });
  if (error) {
    return { ok: false, response: fail("internal_error", error.message, 500, { requestId }) };
  }

  const rank = effectiveRole ? (ROLE_RANK[effectiveRole as Role] ?? 0) : 0;

  // MFA como política de SESSÃO, não só de cadastro.
  //
  // O gate de MFA vivia em `app/app/layout.tsx`, e layout não roda em rota de
  // API: uma sessão `aal1` de admin com TOTP cadastrado chamava direto as 33
  // rotas gateadas por `requireRole("admin")` — criar token de API (plaintext
  // mostrado uma vez), convidar membro, LGPD anonymize, publicar agente,
  // credenciais. Pior, o layout perguntava a coisa errada: `isMfaEnrolled()` é
  // "tem fator", não "provou o fator agora".
  //
  // Fica DEPOIS do rank e ANTES do retorno de sucesso, de propósito: quem não
  // tem papel suficiente continua levando 403 por falta de papel, sem que a
  // resposta revele o estado de MFA de quem nem chegaria lá.
  let mfaRequired = false;
  if (rank >= ROLE_RANK[min]) {
    const mfa = await mfaPendente;
    if ("error" in mfa) throw mfa.error;
    mfaRequired = mfa.required;
  }
  if (mfaRequired) {
    void audit({
      action: "authz.denied",
      actorUserId: user.id,
      organizationId: org.orgId,
      resourceType: resource ?? null,
      requestId,
      metadata: { reason: "mfa_required", effective_role: effectiveRole ?? null },
    });
    return { ok: false, response: fail("mfa_required", t(MENSAGEM_DE_MFA), 403, { requestId }) };
  }

  if (rank < ROLE_RANK[min]) {
    // Fire-and-forget: falha de audit alerta, não bloqueia o 403.
    void audit({
      action: "authz.denied",
      actorUserId: user.id,
      organizationId: org.orgId,
      resourceType: resource ?? null,
      requestId,
      metadata: { required_role: min, effective_role: effectiveRole ?? null },
    });
    return {
      ok: false,
      response: fail("forbidden_role", `Permissão insuficiente. Requer role >= ${min}.`, 403, {
        requestId,
      }),
    };
  }

  return { ok: true, user, org: { ...org, role: effectiveRole as Role } };
}
