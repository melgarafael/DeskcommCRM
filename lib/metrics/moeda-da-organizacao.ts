/**
 * A moeda da organização, lida pelo cliente de serviço com filtro explícito.
 *
 * `resolveAuthDual` não devolve a moeda: na sessão ela vinha do `requireRole`
 * (`org.currency`), e no ramo do token não existe esse objeto. Os dois ramos
 * leem aqui, da MESMA linha (`organizations.id = organizationId`, com o id que
 * o portão resolveu — da sessão ou da linha do token, nunca da query), para a
 * resposta do token ser igual à da sessão.
 *
 * Sem o service role configurado (dev) devolve `null`, o mesmo que uma
 * organização sem moeda: `separarValoresDoPeriodo` cai no código do negócio.
 */
import { isServiceRoleConfigured } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";

export async function moedaDaOrganizacao(organizationId: string): Promise<string | null> {
  if (!isServiceRoleConfigured()) return null;
  const { data } = await createAdminClient()
    .from("organizations")
    .select("currency")
    .eq("id", organizationId)
    .maybeSingle();
  const moeda = (data as { currency?: string | null } | null)?.currency;
  return typeof moeda === "string" && moeda.trim() !== "" ? moeda : null;
}
