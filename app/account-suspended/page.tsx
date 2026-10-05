import { redirect } from "next/navigation";
import { z } from "zod";

import { signOut } from "@/app/actions/auth/signOut";
import { LgpdRequestDetail } from "@/app/app/lgpd/requests/[id]/_client";
import { RequestsTable } from "@/app/app/lgpd/requests/RequestsTable";
import { OutrasOrganizacoes } from "@/app/onboarding/_components/OutrasOrganizacoes";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { orgAtivaSemPortao, requireAuth } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { emailDeSuporte } from "@/lib/branding/saida";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import { traduzir } from "@/lib/i18n/dicionario";
import { ehOperante } from "@/lib/organizacao/operante";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Conta suspensa",
};

const PEDIDO = z.uuid();

/**
 * O HUB de quem está numa empresa suspensa (spec da cobrança do revendedor, §9).
 *
 * Fica fora de `app/app/` de propósito: quem manda a empresa suspensa para cá é
 * o layout de `/app`, então nada aqui pode depender dele. Não lê `x-pathname`:
 * o `proxy.ts` grava esse cabeçalho DEPOIS do `NextResponse.next`.
 *
 * Esta tela entregava o NOSSO endereço de suporte ao cliente de um revendedor,
 * e aqui isso é ativamente errado: quem suspendeu a conta foi o revendedor, e
 * escrever para nós não desbloqueia nada. O endereço sai de `SUPPORT_EMAIL`
 * (o do operador) e, quando ninguém configurou, o parágrafo do contato NÃO
 * renderiza.
 *
 * ponytail: nesta entrega ninguém produz a suspensão de kind `cobranca`, e se
 * ela aparecer recebe o mesmo texto administrativo. Por isso a página não lê
 * `suspended_kind`. O painel de pagamento entra com a régua (PR 3a).
 */
export default async function AccountSuspendedPage({
  searchParams,
}: {
  searchParams: Promise<{ pedido?: string }>;
}) {
  const user = await requireAuth();
  const ativa = await orgAtivaSemPortao(user);
  if (!ativa) redirect("/app");

  // Service role com ids que vieram da SESSÃO (a org ativa e os vínculos do
  // próprio usuário), nunca da URL. Uma leitura responde as duas perguntas:
  // a ativa opera? e quais das outras operam?
  const ids = [...new Set([ativa.orgId, ...user.organizations.map((o) => o.organization_id)])];
  const { data: orgs, error } = await createAdminClient()
    .from("organizations")
    .select("id, status")
    .in("id", ids);
  // Leitura que não aconteceu não vira resposta: redirecionar por palpite
  // prenderia a pessoa num laço com o layout de `/app`.
  if (error) throw new Error(`account_suspended_status_indisponivel: ${error.message}`);
  const statusDe = new Map((orgs ?? []).map((o) => [o.id, o.status]));
  // Volta para `/app` só quando AS DUAS réguas que o layout de `/app` usa dizem
  // que a org opera: a da sessão (`org_status`, a do `resolveActiveOrg`) e a do
  // banco (a leitura por service role, a do `orgRow.status` do layout). O layout
  // manda para cá quando QUALQUER uma diz parada; olhar só uma aqui faria da
  // divergência um laço de 307.
  // Com `?pedido=` (o e-mail de prazo da LGPD chega aqui por
  // `app/lgpd/pedido/[id]/route.ts`), volta ao PEDIDO: é aqui que o link decide
  // no clique se a empresa opera.
  const { pedido } = await searchParams;
  const pedidoValido = PEDIDO.safeParse(pedido).success ? pedido : undefined;
  if (ehOperante(ativa.org_status) && ehOperante(statusDe.get(ativa.orgId))) {
    redirect(pedidoValido ? `/app/lgpd/requests/${pedidoValido}` : "/app");
  }

  const idioma = user.idioma;
  const t = (texto: string) => traduzir(texto, idioma);
  // A MESMA régua da página `/app/lgpd/requests` e das rotas `/api/v1/lgpd/**`.
  const administra =
    (user.is_platform_admin && !user.support) || ROLE_RANK[ativa.role] >= ROLE_RANK.admin;
  const suporte = administra ? await emailDeSuporte() : "";
  const outras = user.organizations
    .filter((o) => o.organization_id !== ativa.orgId && ehOperante(statusDe.get(o.organization_id)))
    .map((o) => ({ id: o.organization_id, nome: o.organization_name }));
  const pedidoAberto = administra ? pedidoValido : undefined;

  return (
    <IdiomaProvider locale={idioma}>
      <main className="flex min-h-screen flex-col items-center gap-8 p-4 sm:p-8">
        <Card className="w-full max-w-md space-y-4 p-8 text-center">
          <h1 className="text-2xl font-semibold">{t("Conta suspensa")}</h1>
          {/* Quem participa de várias empresas precisa saber QUAL parou. Dado, não interface: sem t(). */}
          <p className="text-base font-medium">{ativa.name}</p>
          {!administra ? (
            <p className="text-sm text-muted-foreground">
              {t("Sua conta está suspensa. Avise o administrador da sua empresa.")}
            </p>
          ) : suporte ? (
            <p className="text-sm text-muted-foreground">
              {t("Sua conta está suspensa. Entre em contato com")}{" "}
              <a
                href={`mailto:${suporte}`}
                className="underline underline-offset-4 hover:text-foreground transition-colors"
              >
                {suporte}
              </a>{" "}
              {t("para mais informações.")}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t(
                "Sua conta está suspensa. Fale com quem administra este sistema para saber o motivo e como reativá-la.",
              )}
            </p>
          )}
          <div className="flex flex-wrap items-center justify-center gap-2 pt-2">
            <OutrasOrganizacoes outras={outras} />
            {/* Encerra a sessão, como a irmã /acesso-revogado: um link para /login
                deixava a pessoa logada, e o próximo /app a trazia de volta aqui. */}
            <form action={signOut}>
              <Button type="submit" variant="outline">
                {t("Sair")}
              </Button>
            </form>
          </div>
        </Card>
        {administra && (
          <section aria-labelledby="lgpd-no-hub" className="w-full max-w-5xl space-y-4">
            <header className="space-y-1">
              <h2 id="lgpd-no-hub" className="text-lg font-semibold">
                {t("Solicitações LGPD")}
              </h2>
              <p className="text-sm text-muted-foreground">
                {t("Os pedidos de LGPD dos seus clientes continuam com prazo durante a suspensão.")}
              </p>
            </header>
            {pedidoAberto ? (
              <LgpdRequestDetail id={pedidoAberto} hrefDaLista="/account-suspended" />
            ) : (
              <RequestsTable baseDoPedido="/account-suspended?pedido=" />
            )}
          </section>
        )}
      </main>
    </IdiomaProvider>
  );
}
