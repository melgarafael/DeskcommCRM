/**
 * Os DADOS CADASTRAIS da organização — uma gravação só para as duas portas que
 * os editam: a tela de Configurações do próprio tenant (`updateTenant`) e a de
 * gestão de tenants do admin da plataforma (`PATCH /api/v1/admin/tenants/[id]`).
 *
 * Duas portas com duas cópias da regra divergiriam na primeira mudança — e a
 * regra aqui não é trivial: o país só entra se tiver PERFIL REVISADO (issue
 * #1033), porque é ele que decide qual lei o PDF de acesso do titular cita.
 *
 * A escrita vai pelo service role porque a única policy de escrita de
 * `organizations` é a do admin da plataforma (ver o comentário em
 * `app/actions/settings/updateTenant.ts`). Quem chama já decidiu a autorização.
 */
import { paisesOferecidos } from "@/lib/legal/perfil-do-pais";
import type { TenantInput } from "@/lib/schemas/settings";
import type { createAdminClient } from "@/lib/supabase/admin";

export type ResultadoDaGravacao = { ok: true } | { ok: false; erro: string };

export async function gravarDadosCadastrais(
  admin: ReturnType<typeof createAdminClient>,
  orgId: string,
  dados: TenantInput,
): Promise<ResultadoDaGravacao> {
  const pais = dados.country ?? null;
  if (pais !== null && !paisesOferecidos().some((p) => p.codigo === pais)) {
    return { ok: false, erro: `País sem perfil revisado: ${pais}` };
  }

  const { error } = await admin
    .from("organizations")
    .update({
      display_name: dados.display_name,
      legal_name: dados.legal_name,
      cnpj: dados.cnpj ?? null,
      country: pais,
      timezone: dados.timezone,
      locale: dados.locale,
      currency: dados.currency,
      media_retention_days: dados.media_retention_days,
      media_retention_enforced: dados.media_retention_enforced,
      dpo_email: dados.dpo_email ?? null,
      privacy_policy_url: dados.privacy_policy_url ?? null,
    })
    .eq("id", orgId);
  if (error) {
    // CNPJ é único na instalação: dois tenants com o mesmo documento é erro de
    // cadastro, e a mensagem precisa dizer isso em vez do texto do Postgres.
    if (error.code === "23505") return { ok: false, erro: "cnpj_em_uso" };
    return { ok: false, erro: error.message };
  }
  return { ok: true };
}
