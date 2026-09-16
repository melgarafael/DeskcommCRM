import Link from "next/link";

import { branding } from "@/lib/branding";
import { createClient } from "@/lib/supabase/server";
import { normalizarIdioma } from "@/lib/i18n/idiomas";
import { traduzir } from "@/lib/i18n/dicionario";

/**
 * Container de leitura longa.
 *
 * Não usa o grupo `app/(public)/`: aquele layout é um cartão centrado de 384px,
 * desenhado para o formulário de login, e espremeria um documento inteiro numa
 * coluna de cartão. Aqui a medida é de texto corrido.
 */
export default async function LegalLayout({ children }: { children: React.ReactNode }) {
  const marca = branding();
  // Fora da árvore de `app/app/layout.tsx` — sem `IdiomaProvider`, então
  // resolve o idioma direto, como as páginas filhas (`privacy`/`terms`).
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const idioma = normalizarIdioma(
    (user?.user_metadata?.locale as string | undefined) ?? null,
  );

  return (
    <div className="min-h-screen bg-muted/40">
      <header className="border-b bg-background">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-4 px-6 py-4">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">{marca.name}</p>
          <Link href="/login" className="text-sm underline underline-offset-2">
            {traduzir("Voltar", idioma)}
          </Link>
        </div>
      </header>
      <main className="mx-auto w-full max-w-3xl px-6 py-10">
        <article className="space-y-6 rounded-lg border bg-background p-8 text-sm leading-relaxed">
          {children}
        </article>
      </main>
    </div>
  );
}
