import Link from "next/link";
import { notFound } from "next/navigation";

import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { ROTULO_DO_ESTADO } from "@/lib/cobranca/rotulos";
import type { EstadoDaAssinatura } from "@/lib/cobranca/vocabulario";
import { traduzir } from "@/lib/i18n/dicionario";
import { normalizarIdioma } from "@/lib/i18n/idiomas";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { COLUNAS_DO_PLANO } from "@/lib/schemas/cobranca-plano";
import { createAdminClient } from "@/lib/supabase/admin";

import { PlanosDaInstalacao, type PlanoDaTela } from "./_planos";

export const metadata = { title: "Cobrança — Admin Plataforma" };
export const dynamic = "force-dynamic";

interface ClienteDaTela {
  id: string;
  display_name: string;
  cobranca_assinaturas: { plano_id: string; estado: EstadoDaAssinatura; trial_ate: string | null; prazo_extra_ate: string | null };
}

/**
 * /admin/cobranca (spec da cobrança do revendedor §9), PR 2: Planos e Clientes.
 * Conexão, Régua e Visão geral chegam com o provedor (PR 3a). Chave desligada
 * → 404, e a porta some do menu. As ações sobre uma empresa (atribuir, trocar,
 * dar prazo, isentar) moram no card Cobrança do painel dela; a lista leva lá.
 *
 * A lista parte de `organizations` (da instalação) com a assinatura embutida
 * (`!inner`: só quem tem linha): é cross-tenant por desenho, como /admin/tenants.
 * Leitura que falha LANÇA — a tela não mostra "nenhum cliente" de quem não leu.
 */
export default async function CobrancaPage() {
  const { user } = await requirePlatformAdmin();
  const idioma = normalizarIdioma((user.user_metadata?.locale as string | undefined) ?? null);
  const t = (texto: string) => traduzir(texto, idioma);
  const admin = createAdminClient();
  if (!(await moduloLigado(admin, "cobranca"))) notFound();

  const [planos, clientes] = await Promise.all([
    admin.from("cobranca_planos").select(COLUNAS_DO_PLANO).order("nome"),
    admin
      .from("organizations")
      .select("id, display_name, cobranca_assinaturas!inner(plano_id, estado, trial_ate, prazo_extra_ate)")
      .order("display_name"),
  ]);
  if (planos.error || clientes.error) {
    throw new Error(`cobrança: leitura falhou (${planos.error?.code ?? clientes.error?.code})`);
  }
  const lista = (planos.data ?? []) as PlanoDaTela[];
  const nomeDoPlano = new Map(lista.map((p) => [p.id, p.nome]));
  const pagantes = (clientes.data ?? []) as unknown as ClienteDaTela[];
  const data = new Intl.DateTimeFormat(idioma, { dateStyle: "short" });

  return (
    <div className="space-y-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t("Cobrança dos seus clientes")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("Os planos que você vende e as empresas que pagam. Empresa sem plano é isenta: não paga e não tem limites.")}
        </p>
      </header>

      <section aria-labelledby="planos" className="space-y-3">
        <h2 id="planos" className="text-lg font-semibold">{t("Planos")}</h2>
        <PlanosDaInstalacao planos={lista} />
      </section>

      <section aria-labelledby="clientes" className="space-y-3">
        <h2 id="clientes" className="text-lg font-semibold">{t("Clientes")}</h2>
        {pagantes.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("Nenhuma empresa paga ainda. Atribua um plano no painel da empresa, em Tenants.")}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-2 pr-4 font-medium">{t("Empresa")}</th>
                  <th className="pr-4 font-medium">{t("Plano")}</th>
                  <th className="pr-4 font-medium">{t("Situação")}</th>
                  <th className="pr-4 font-medium">{t("Teste grátis até")}</th>
                  <th className="pr-4 font-medium">{t("Prazo extra até")}</th>
                  <th><span className="sr-only">{t("Abrir")}</span></th>
                </tr>
              </thead>
              <tbody>
                {pagantes.map((c) => {
                  const a = c.cobranca_assinaturas;
                  return (
                    <tr key={c.id} className="border-t">
                      <td className="py-2 pr-4">{c.display_name}</td>
                      <td className="pr-4">{nomeDoPlano.get(a.plano_id) ?? "—"}</td>
                      <td className="pr-4">{t(ROTULO_DO_ESTADO[a.estado])}</td>
                      <td className="pr-4">{a.trial_ate ? data.format(new Date(a.trial_ate)) : "—"}</td>
                      <td className="pr-4">{a.prazo_extra_ate ? data.format(new Date(a.prazo_extra_ate)) : "—"}</td>
                      <td>
                        <Link href={`/admin/tenants/${c.id}`} className="underline">{t("Abrir")}</Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
