import Link from "next/link";
import { redirect } from "next/navigation";

import { env } from "@/lib/env";
import { isBillingEnabled } from "@/lib/asaas/config";
import { marcaDaInstalacao } from "@/lib/branding/instalacao";
import { resolverMarcaDaOrganizacao } from "@/lib/branding/organizacao";
import { cssDaMarca } from "@/lib/branding/css";
import { createAdminClient } from "@/lib/supabase/admin";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export const dynamic = "force-dynamic";

/**
 * A raiz não tinha conteúdo próprio: mandava direto pro painel (comportamento
 * que o self-host mantém, intocado — é o default de `BILLING_MODE=disabled`).
 *
 * Fase 4 do pivot ADR-0002: quando a instância roda `BILLING_MODE=asaas`
 * (só a oficial hospedada), a raiz vira a landing comercial da marca
 * configurada — nome, cor e preços vêm do resolvedor de branding e de
 * `billing_plans`, não de texto fixo da Genesisia. Um clone self-host nunca
 * vê este conteúdo: a mesma imagem serve as duas coisas, e é a flag de
 * plataforma que decide qual.
 */
export default async function HomePage() {
  if (!isBillingEnabled()) {
    redirect("/app");
    return null;
  }

  const marca = resolverMarcaDaOrganizacao(null, await marcaDaInstalacao(), env);
  const { css: cssMarca } = cssDaMarca(marca.cor);

  const admin = createAdminClient();
  const { data: plans } = await admin
    .from("billing_plans")
    .select("id, code, name, description, price_cents, currency, billing_interval, features")
    .eq("is_active", true)
    .order("sort_order", { ascending: true });

  return (
    <>
      {cssMarca ? <style dangerouslySetInnerHTML={{ __html: cssMarca }} /> : null}
      <main className="min-h-screen bg-background text-foreground">
        <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
          <div className="flex items-center gap-2 font-semibold tracking-tight">
            {marca.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={marca.logoUrl} alt={marca.name} className="h-8 w-auto" />
            ) : (
              <span className="text-lg">{marca.name}</span>
            )}
          </div>
          <nav className="flex items-center gap-2">
            <Button asChild variant="ghost">
              <Link href="/login">Entrar</Link>
            </Button>
            <Button asChild>
              <Link href="/signup">Criar conta</Link>
            </Button>
          </nav>
        </header>

        <section className="mx-auto max-w-4xl px-6 py-20 text-center">
          <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
            CRM de vendas com IA, e contabilidade, num só lugar
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-muted-foreground">
            {marca.name} une o atendimento por WhatsApp com agentes de IA, funil de
            vendas e a gestão contábil do seu escritório — sem precisar administrar
            servidor nenhum.
          </p>
          <div className="mt-8 flex items-center justify-center gap-3">
            <Button asChild size="lg">
              <Link href="/signup">Começar agora</Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href="/login">Já tenho conta</Link>
            </Button>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-6 py-12">
          <div className="grid gap-6 sm:grid-cols-3">
            <Card className="p-6">
              <h2 className="text-sm font-semibold">Atendimento com IA</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                Agentes de IA atendem e qualificam pelo WhatsApp, lado a lado com sua
                equipe, com histórico e handoff auditado.
              </p>
            </Card>
            <Card className="p-6">
              <h2 className="text-sm font-semibold">Funil de vendas</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                Kanban configurável para o seu negócio, com pipeline, tags e
                automações — o funil anda sozinho.
              </p>
            </Card>
            <Card className="p-6">
              <h2 className="text-sm font-semibold">Contabilidade</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                Cadastro de clientes atendidos, plano de contas, lançamentos e
                contas a pagar/receber — sem sair do mesmo sistema.
              </p>
            </Card>
          </div>
        </section>

        {plans && plans.length > 0 && (
          <section className="mx-auto max-w-6xl px-6 py-16">
            <h2 className="text-center text-2xl font-semibold tracking-tight">Planos</h2>
            <div className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {plans.map((plan) => (
                <Card key={plan.id} className="flex flex-col gap-4 p-6">
                  <div>
                    <h3 className="text-sm font-semibold">{plan.name}</h3>
                    {plan.description && (
                      <p className="mt-1 text-sm text-muted-foreground">{plan.description}</p>
                    )}
                  </div>
                  <p className="text-3xl font-semibold">
                    {(plan.price_cents / 100).toLocaleString("pt-BR", {
                      style: "currency",
                      currency: plan.currency,
                    })}
                    <span className="text-sm font-normal text-muted-foreground">
                      /{plan.billing_interval === "monthly" ? "mês" : "ano"}
                    </span>
                  </p>
                  <Button asChild className="mt-auto">
                    <Link href={`/signup?plan=${plan.id}`}>Assinar {plan.name}</Link>
                  </Button>
                </Card>
              ))}
            </div>
          </section>
        )}

        <footer className="mx-auto max-w-6xl px-6 py-10 text-center text-sm text-muted-foreground">
          {marca.name} — construído sobre o DeskcommCRM, open source.
        </footer>
      </main>
    </>
  );
}
