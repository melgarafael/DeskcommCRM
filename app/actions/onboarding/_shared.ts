/**
 * Shared helpers for onboarding Server Actions: resolve auth + active org +
 * admin client (we use service-role here because we do narrow targeted
 * UPDATEs scoped explicitly by `organization_id` resolved from the validated
 * session). The body may only CHOOSE among the user's own memberships —
 * validated here, against the same operant-org rule as `resolveActiveOrg` —
 * never name an arbitrary org id.
 */
import { supportWriteError } from "@/lib/impersonate/support";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ehOperante } from "@/lib/organizacao/operante";
import { redirect } from "next/navigation";
import type { OnboardingState } from "@/lib/schemas/onboarding";

export class OnboardingError extends Error {
  constructor(
    public readonly code:
      | "auth_required"
      | "no_active_org"
      | "forbidden"
      | "not_found"
      | "db_error"
      | "org_ja_configurada",
    message: string,
  ) {
    super(message);
    this.name = "OnboardingError";
  }
}

export interface OnboardingCtx {
  userId: string;
  orgId: string;
  orgName: string;
  role: string;
  fullName: string | null;
  email: string;
}

export async function requireOnboardingCtx(orgIdDaAba?: string): Promise<OnboardingCtx> {
  const user = await loadAuthUser();
  if (!user) throw new OnboardingError("auth_required", "Auth required.");
  if (supportWriteError(user.support)) throw new OnboardingError("forbidden", "Acompanhamento somente leitura ou encerrado.");

  // A aba de boas-vindas foi aberta para UMA organização. Trocar de org ativa
  // em outra aba (o cookie `active_org`) NÃO pode redirecionar este submit
  // para a organização errada: o id vem da própria aba e só é aceito se for
  // uma membership REAL do usuário. Um id arbitrário do corpo jamais alcança
  // o `.eq("id", …)` do UPDATE — sem membership ele é RECUSADO (cair na org
  // ativa seria o próprio #2068 por outra porta).
  if (orgIdDaAba) {
    const membro = user.organizations.find((o) => o.organization_id === orgIdDaAba);
    if (membro) {
      // A mesma régua do `resolveActiveOrg`: org não operante não recebe
      // escrita — este caminho não passa por ele, então repete o portão.
      if (!ehOperante(membro.org_status)) redirect("/account-suspended");
      return {
        userId: user.id,
        orgId: membro.organization_id,
        orgName: membro.organization_name,
        role: membro.role,
        fullName: user.full_name,
        email: user.email,
      };
    }
    // Acompanhamento (suporte) não tem membership e cairia aqui — mas o layout
    // do onboarding já expulsa essas sessões (`app/onboarding/layout.tsx`,
    // `if (user.support) redirect(...)`), então a recusa não corta o suporte.
    // Se aquele redirect sair, o teste "acompanhamento ... é recusado" mostra.
    throw new OnboardingError("forbidden", "A organização desta aba não está mais entre os seus vínculos.");
  }

  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) throw new OnboardingError("no_active_org", "Sem organização ativa.");
  return {
    userId: user.id,
    orgId: activeOrg.orgId,
    orgName: activeOrg.name,
    role: activeOrg.role,
    fullName: user.full_name,
    email: user.email,
  };
}

export async function loadOnboardingState(orgId: string): Promise<{
  state: OnboardingState;
  onboardedAt: string | null;
}> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("organizations")
    .select("onboarding_state, onboarded_at")
    .eq("id", orgId)
    .maybeSingle();
  if (error) throw new OnboardingError("db_error", error.message);
  if (!data) throw new OnboardingError("not_found", "Organização não encontrada.");
  return {
    state: (data.onboarding_state as OnboardingState | null) ?? {},
    onboardedAt: (data.onboarded_at as string | null) ?? null,
  };
}

export async function patchOnboardingState(
  orgId: string,
  patch: Partial<OnboardingState>,
  extra?: { display_name?: string; timezone?: string },
  /**
   * `soNoWizard`: grava só se a organização ainda NÃO terminou o onboarding
   * e recusa com `org_ja_configurada` caso contrário. Só as boas-vindas pedem
   * isso (#2113). Os outros passos já tiveram efeito fora daqui (agente
   * publicado, convite enviado, quadro aplicado) e precisam registrar o passo
   * mesmo numa aba antiga — recusar ali deixaria o efeito sem estado,
   * auditoria nem evento.
   */
  opcoes?: { soNoWizard?: boolean },
): Promise<void> {
  const admin = createAdminClient();
  const { state } = await loadOnboardingState(orgId);
  const merged: OnboardingState = { ...state, ...patch };
  const update: Record<string, unknown> = { onboarding_state: merged };
  if (extra?.display_name) update.display_name = extra.display_name;
  if (extra?.timezone) update.timezone = extra.timezone;
  if (!opcoes?.soNoWizard) {
    const { error } = await admin.from("organizations").update(update).eq("id", orgId);
    if (error) throw new OnboardingError("db_error", error.message);
    return;
  }
  // #2113: a aba de boas-vindas pode ficar aberta enquanto o onboarding é
  // concluído em OUTRA aba. Sem esta condição, o submit regravava
  // `display_name` e `onboarding_state` numa organização já configurada.
  // O `.is("onboarded_at", null)` faz a escrita só na organização que ainda
  // está no wizard; o `.select("id")` devolve as linhas afetadas (PostgREST),
  // e zero linhas quer dizer "alguém terminou antes" — aí NÃO se grava nada.
  const { data, error } = await admin
    .from("organizations")
    .update(update)
    .eq("id", orgId)
    .is("onboarded_at", null)
    .select("id");
  if (error) throw new OnboardingError("db_error", error.message);
  // Com `.select("id")` o contrato do PostgREST é um ARRAY de linhas afetadas:
  // `[]` = nenhuma bateu no filtro (org já configurada, ou finalizada entre a
  // releitura e a escrita). Um array vazio é a única resposta que significa
  // "zero linhas" — `data` nulo vem de dublê que não simula o `select`.
  if (Array.isArray(data) && data.length === 0) {
    throw new OnboardingError("org_ja_configurada", "Organização já configurada.");
  }
}
