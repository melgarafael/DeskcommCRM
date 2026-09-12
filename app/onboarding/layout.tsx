import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { loadOnboardingState } from "@/app/actions/onboarding/_shared";
import { Stepper } from "./_components/Stepper";
import { OutrasOrganizacoes } from "./_components/OutrasOrganizacoes";
import { SkipToEnd } from "./_components/SkipToEnd";
import { SimboloDoProduto } from "@/components/branding/MarcaDoProduto";
import { branding, marcaEhADoProduto } from "@/lib/branding";
import { passosVisiveis } from "@/lib/onboarding/passos";
import { env } from "@/lib/env";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";

export default async function OnboardingLayout({ children }: { children: React.ReactNode }) {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  // Acompanhamento observa a organização incompleta no shell com saída explícita.
  if (user.support) redirect("/app/inbox");
  // Sem organização o onboarding não tem o que mostrar — mas mandar para
  // `/login` fechava o círculo: quem entrasse de novo voltaria para cá. A saída
  // é a tela que CRIA a organização que falta.
  if (!activeOrg) redirect("/get-started");

  const { state, onboardedAt } = await loadOnboardingState(activeOrg.orgId);
  if (onboardedAt) redirect("/app/inbox");

  // Os passos que ESTA instalação oferece, com o que já foi resolvido. O
  // indicador não decide mais nada sozinho — ele desenha o que recebe.
  const passos = passosVisiveis({ lojaLigada: env.NUVEMSHOP_ENABLED }).map((p) => ({
    segmento: p.segmento,
    rotulo: p.rotulo,
    cumprido: p.cumprido(state),
  }));

  const isDev = process.env.NODE_ENV !== "production";
  const marca = branding();

  return (
    <IdiomaProvider locale={user.locale}>
      <div className="flex min-h-screen flex-col bg-muted/40">
        <header className="border-b bg-background">
          <div className="mx-auto flex w-full max-w-3xl items-center justify-between px-6 py-4">
            <div className="flex items-center gap-3">
              {/* O nome está escrito logo abaixo — o símbolo é reforço, não legenda. */}
              {marcaEhADoProduto(marca) && (
                <SimboloDoProduto nome={marca.name} decorativo className="h-9 w-9" />
              )}
              <div>
                <p className="text-xs uppercase tracking-wider text-muted-foreground">{marca.name}</p>
                <h1 className="text-lg font-semibold tracking-tight">{activeOrg.name}</h1>
              </div>
            </div>
            <div className="flex items-center gap-1">
              {/*
                A SAÍDA, para quem tem outra organização. Ver o cabeçalho de
                `OutrasOrganizacoes`: sem ela, trocar de organização pelo seletor
                do topo levava a um wizard sem porta de volta — o layout de `/app`
                sai da árvore e leva o `TenantSwitcher` junto.
              */}
              <OutrasOrganizacoes
                outras={user.organizations
                  .filter((o) => o.organization_id !== activeOrg.orgId)
                  .map((o) => ({ id: o.organization_id, nome: o.organization_name }))}
              />
              {isDev ? <SkipToEnd /> : null}
            </div>
          </div>
          <div className="mx-auto w-full max-w-3xl px-4 pb-2">
            <Stepper passos={passos} />
          </div>
        </header>
        <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8">{children}</main>
      </div>
    </IdiomaProvider>
  );
}
