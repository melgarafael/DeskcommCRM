import Link from "next/link";
import { redirect } from "next/navigation";

import { signOut } from "@/app/actions/auth/signOut";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { exigirProvaDeMfa, orgAtivaSemPortao, requireAuth } from "@/lib/auth/server";
import { lerIntencaoDeContratacao, podeContinuarContratacao, primeiroPagamentoPendente } from "@/lib/cobranca/contratacao";
import { provedorDaInstalacao } from "@/lib/cobranca/configuracao";
import { sugestaoDoCadastro } from "@/lib/cobranca/documento";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import { traduzir } from "@/lib/i18n/dicionario";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ProvedorDeCobranca } from "@/lib/cobranca/vocabulario";
import { ContinuarPagamento } from "@/components/cobranca/ContinuarPagamento";

export const dynamic = "force-dynamic";
export const metadata = { title: "Continuar contratação" };

/** GET só lê. O POST nativo conserva os guards e a reserva de checkout. */
export default async function ContratarPage({ searchParams }: {
  searchParams: Promise<{ retomar?: string; voltou?: string }>;
}) {
  const user = await requireAuth();
  const ativa = await orgAtivaSemPortao(user);
  if (!ativa) redirect("/get-started");
  if (!podeContinuarContratacao(user, ativa.role)) redirect("/account-suspended");
  await exigirProvaDeMfa();
  const db = createAdminClient();
  if (!(await moduloLigado(db, "cobranca"))) redirect("/app");
  const [org, assinatura] = await Promise.all([
    db.from("organizations").select("status, suspended_kind, cnpj").eq("id", ativa.orgId).maybeSingle(),
    db.from("cobranca_assinaturas").select("plano_id, estado, pagamento_inicial_pendente, periodo_pago_desde, provedor, provedor_cliente_id, checkout_url, link_de_pagamento")
      .eq("organization_id", ativa.orgId).maybeSingle(),
  ]);
  if (org.error || assinatura.error || !org.data) throw new Error("contratacao: estado indisponível");
  if (org.data.status === "active") redirect("/onboarding/welcome");
  if (org.data.suspended_kind !== "cobranca" || !primeiroPagamentoPendente(assinatura.data)) redirect("/account-suspended");
  const a = assinatura.data!;
  const { data: plano, error } = await db.from("cobranca_planos").select("id, nome, preco_cents, intervalo")
    .eq("id", a.plano_id).maybeSingle();
  if (error || !plano) throw new Error("contratacao: plano indisponível");
  const intencao = await lerIntencaoDeContratacao(db, user.id, ativa.orgId);
  const params = await searchParams;
  const provedor = (a.provedor as ProvedorDeCobranca | null) ?? await provedorDaInstalacao();
  const t = (v: string) => traduzir(v, user.idioma);
  const preco = new Intl.NumberFormat(user.idioma, { style: "currency", currency: "BRL" }).format(Number(plano.preco_cents) / 100);
  return (
    <IdiomaProvider locale={user.idioma}>
      <main className="flex min-h-screen flex-col items-center gap-8 p-4 sm:p-8">
        <Card className="w-full max-w-xl space-y-5 p-8">
          <p className="text-sm text-muted-foreground">{t("Conta confirmada · Pagamento · Primeiros passos")}</p>
          <h1 className="text-2xl font-semibold">{t("Continue sua contratação")}</h1>
          <p>{ativa.name}</p>
          <section aria-label={t("Plano escolhido")} className="rounded-md border p-4">
            <h2 className="font-semibold">{plano.nome}</h2>
            <p>{preco} / {t(plano.intervalo === "ano" ? "ano · pagamento anual de uma vez" : "mês")}</p>
          </section>
          <p className="text-sm text-muted-foreground">{t("O acesso será liberado após a confirmação do pagamento. Depois, você poderá configurar seu ambiente.")}</p>
          <ContinuarPagamento
            temIntencao={intencao !== null} automatico={intencao !== null && params.retomar !== "1" && params.voltou !== "1"}
            provedor={provedor} clienteExiste={a.provedor_cliente_id !== null}
            documentoInicial={sugestaoDoCadastro(org.data.cnpj)} voltou={params.voltou === "1"}
            cancelada={a.estado === "cancelada"}
          />
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <Link href="/account-suspended?ajuda=1">{t("Precisa de ajuda?")}</Link>
            <form action={signOut}><Button variant="ghost" type="submit">{t("Sair")}</Button></form>
          </div>
        </Card>
      </main>
    </IdiomaProvider>
  );
}
