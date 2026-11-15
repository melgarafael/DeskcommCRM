import { lerMoldeDeIa } from "@/lib/instalacao/molde-de-ia-servidor";
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
      .select("id, nome, preco_cents, moeda, intervalo, trial_dias")
      .is("arquivado_em", null)
      .order("nome");
    if (error) throw new Error(`planos de cobrança: leitura falhou (${error.code})`);
    planos = (data ?? []) as PlanoParaEscolher[];
  }
  return <NewTenantForm cobranca={{ ligada, planos }} moldeDeIa={await nomeDoMoldeDeIa(admin)} />;
}

/**
 * O molde de IA em vigor (migration 9096), pelo nome — ou `null` quando não há
 * molde ou a leitura falhou. Falhar aqui NÃO lança, ao contrário dos planos: o
 * aviso é informação, e sem ele o formulário cria a empresa do mesmo jeito.
 */
async function nomeDoMoldeDeIa(admin: ReturnType<typeof createAdminClient>): Promise<{ nome: string } | null> {
  const moldeId = await lerMoldeDeIa(admin);
  if (!moldeId) return null;
  const { data } = await admin.from("organizations").select("display_name").eq("id", moldeId).maybeSingle();
  const nome = (data as { display_name?: string | null } | null)?.display_name?.trim();
  return nome ? { nome } : null;
}
