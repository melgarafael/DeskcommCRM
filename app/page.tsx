import Link from "next/link";
import { redirect } from "next/navigation";

import { marcaDaSaida } from "@/lib/branding/saida";
import { idiomaDoVisitante } from "@/lib/i18n/idiomaAnonimo";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";

/**
 * A página inicial pública.
 *
 * Quem tem sessão segue direto para o painel, como sempre foi. Quem não tem vê
 * uma página que diz o que o produto é e leva à política de privacidade e aos
 * termos — sem pedir login. A verificação de um app que pede dados de conta
 * Google exige exatamente isso: o revisor abre o endereço principal sem entrar e
 * precisa ver o nome do produto, o que ele faz e o link da política.
 *
 * `/` já é caminho público no `proxy` (`lib/auth/public-paths.ts`), então nada
 * lá muda. O nome vem da marca resolvida (`marcaDaSaida`: banco acima do
 * `.env`), nunca de texto fixo: uma imagem serve todas as marcas.
 *
 * `getUser()` e nunca `getSession()`: o redirecionamento só vale para sessão que
 * o servidor de autenticação confirmou.
 */
export const dynamic = "force-dynamic";

export default async function HomePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) redirect("/app");

  const marca = await marcaDaSaida(null);
  const idioma = await idiomaDoVisitante(null);
  const t = (texto: string) => traduzir(texto, idioma);

  return (
    <div className="min-h-screen bg-muted/40">
      <header className="border-b bg-background">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-4 px-6 py-4">
          <p className="text-sm font-semibold tracking-tight">{marca.nome}</p>
          <Link
            href="/login"
            className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
          >
            {t("Entrar")}
          </Link>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl space-y-6 px-6 py-12">
        <div className="space-y-3">
          <h1 className="text-3xl font-semibold tracking-tight">{marca.nome}</h1>
          <p className="text-lg text-muted-foreground">
            {t("Atendimento e vendas pelo WhatsApp, com agentes de inteligência artificial.")}
          </p>
        </div>

        <p className="leading-relaxed">
          {t("O")} {marca.nome}{" "}
          {t(
            "reúne em um só lugar as conversas com os clientes, o funil de vendas, a agenda de atendimentos e agentes de inteligência artificial que respondem, qualificam o interesse e passam a conversa para uma pessoa quando é preciso.",
          )}
        </p>

        <p className="leading-relaxed">
          {t("Quando a empresa conecta o Google Agenda, o")} {marca.nome}{" "}
          {t(
            "mostra a ocupação da agenda e cria, altera e cancela os agendamentos pedidos pela própria pessoa. Quando conecta o Google Ads, devolve ao anúncio as vendas que ele trouxe. O uso dos dados do Google está descrito na",
          )}{" "}
          <Link href="/legal/privacy#dados-do-google" className="underline underline-offset-2">
            {t("Política de Privacidade")}
          </Link>
          .
        </p>
      </main>

      <footer className="border-t bg-background">
        <nav className="mx-auto flex w-full max-w-3xl flex-wrap gap-x-6 gap-y-2 px-6 py-4 text-sm">
          <Link href="/legal/privacy" className="underline underline-offset-2">
            {t("Política de Privacidade")}
          </Link>
          <Link href="/legal/terms" className="underline underline-offset-2">
            {t("Termos de Uso")}
          </Link>
        </nav>
      </footer>
    </div>
  );
}
