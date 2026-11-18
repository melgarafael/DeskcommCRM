import { redirect } from "next/navigation";

import { Card } from "@/components/ui/card";
import { loadAuthUser } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import { buscarCliente } from "@/lib/mcp/oauth/clientes";
import { enderecosOAuth, escoposPedidos, escritaOferecida, recursoConfere } from "@/lib/mcp/oauth/config";
import { pedidoDeAutorizacaoSchema } from "@/lib/mcp/oauth/esquemas";
import { createAdminClient } from "@/lib/supabase/admin";

import { FormularioDeConsentimento } from "./FormularioDeConsentimento";

export const dynamic = "force-dynamic";
export const metadata = { title: "Conectar aplicativo" };

/**
 * TELA DE CONSENTIMENTO do OAuth do MCP — onde a pessoa decide se um
 * aplicativo (ChatGPT, Claude…) pode ler, ou ler e alterar, os dados do CRM.
 *
 * Chega-se aqui só pelo fluxo: o aplicativo abre `/api/mcp/oauth/authorize`,
 * que confere o pedido e segue para cá por uma ponte same-origin (o cookie de
 * sessão é Strict). Sem sessão, o `proxy` leva ao login e volta com `next`.
 *
 * O que a tela mostra é o que a pessoa precisa para não ser enganada: o nome
 * que o aplicativo DECLAROU (o registro é aberto, qualquer um escolhe o nome)
 * ao lado do HOST para onde a autorização vai — esse não se falsifica.
 *
 * Fora da árvore de `app/app/layout.tsx`: resolve o idioma direto, como
 * `acesso-revogado/page.tsx`.
 */
export default async function ConsentirPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const brutos = await searchParams;
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(brutos)) if (typeof v === "string") params[k] = v;

  const user = await loadAuthUser();
  if (!user) {
    redirect(`/login?next=${encodeURIComponent(`/oauth/mcp/consentir?${new URLSearchParams(params).toString()}`)}`);
  }
  const idioma = user.idioma;
  const t = (texto: string) => traduzir(texto, idioma);

  const pedido = pedidoDeAutorizacaoSchema.safeParse(params);
  const cliente = pedido.success ? await buscarCliente(createAdminClient(), pedido.data.client_id) : null;
  const valido =
    pedido.success &&
    cliente !== null &&
    cliente.redirect_uris.includes(pedido.data.redirect_uri) &&
    recursoConfere(pedido.data.resource, enderecosOAuth().recurso);

  const organizacoes = user.organizations
    .filter((o) => o.role === "admin")
    .map((o) => ({ id: o.organization_id, nome: o.organization_name }));

  return (
    <IdiomaProvider locale={idioma}>
      <main className="flex min-h-screen items-center justify-center p-6">
        <Card className="w-full max-w-md space-y-5 p-8" data-testid="consentimento-mcp">
          {!valido || !pedido.success || !cliente ? (
            <>
              <h1 className="text-xl font-semibold">{t("Não foi possível continuar a conexão")}</h1>
              <p className="text-sm text-muted-foreground">
                {t("O pedido de conexão está incompleto ou expirou. Volte ao aplicativo e tente conectar de novo.")}
              </p>
            </>
          ) : organizacoes.length === 0 ? (
            <>
              <h1 className="text-xl font-semibold">{t("Só quem administra a empresa pode conectar aplicativos")}</h1>
              <p className="text-sm text-muted-foreground">
                {t("Peça a quem administra a sua empresa no CRM para fazer a conexão.")}
              </p>
            </>
          ) : (
            <FormularioDeConsentimento
              pedido={pedido.data}
              nomeDoAplicativo={cliente.nome}
              hostDeVolta={new URL(pedido.data.redirect_uri).host}
              organizacoes={organizacoes}
              escritaOferecida={escritaOferecida(escoposPedidos(pedido.data.scope))}
              email={user.email}
            />
          )}
        </Card>
      </main>
    </IdiomaProvider>
  );
}
