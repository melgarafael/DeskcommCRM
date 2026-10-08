import { moduloLigado } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";

import { NewTenantForm, type PlanoParaEscolher } from "./_form";

export const metadata = { title: "Novo Tenant — Admin Plataforma" };
export const dynamic = "force-dynamic";

/**
 * Com a cobrança ligada, o formulário oferece os planos ativos (spec da
 * cobrança §9); desligada, é o formulário de sempre. A leitura dos planos que
 * falha LANÇA: mostrar só "Sem cobrança" criaria isentas em silêncio.
 */
export default async function NewTenantPage() {
  const admin = createAdminClient();
  const ligada = await moduloLigado(admin, "cobranca");
  let planos: PlanoParaEscolher[] = [];
  if (ligada) {
    const { data, error } = await admin
      .from("cobranca_planos")
      .select("id, nome, preco_cents, intervalo, trial_dias")
      .is("arquivado_em", null)
      .order("nome");
    if (error) throw new Error(`planos de cobrança: leitura falhou (${error.code})`);
    planos = (data ?? []) as PlanoParaEscolher[];
  }
  return <NewTenantForm cobranca={{ ligada, planos }} />;
}
