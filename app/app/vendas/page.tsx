/**
 * Análise › Vendas — o painel de vendas.
 *
 * O período inicial ("Este mês") é calculado AQUI, no servidor e no fuso da
 * empresa, e entra como prop: o componente não lê o relógio do navegador no
 * `useState`, para a primeira renderização ser a mesma no servidor e no cliente.
 */
import { redirect } from "next/navigation";

import { PainelDeVendas } from "@/components/relatorios/painel-de-vendas";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { periodoDoAtalho } from "@/lib/relatorios/atalhos-de-periodo";
import { fusoDoRelatorio } from "@/lib/relatorios/janela";

export const metadata = { title: "Vendas" };
export const dynamic = "force-dynamic";

export default async function Page() {
  const user = await requireAuth();
  const org = await resolveActiveOrg(user);
  if (!org) redirect("/app");

  const t = (texto: string) => traduzir(texto, user.idioma);
  const tz = fusoDoRelatorio(org.timezone ?? null);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
      <div>
        <h1 className="text-xl font-semibold">{t("Vendas")}</h1>
        <p className="text-sm text-text-muted">
          {t("Quanto você vendeu, quantas vendas, o ticket médio e a conversão — os negócios ganhos no funil.")}
        </p>
      </div>
      <PainelDeVendas periodoInicial={periodoDoAtalho("mes", new Date(), tz)} tz={tz} />
    </div>
  );
}
