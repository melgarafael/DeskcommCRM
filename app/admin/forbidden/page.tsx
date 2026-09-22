import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { createClient } from "@/lib/supabase/server";
import { normalizarIdioma } from "@/lib/i18n/idiomas";
import { traduzir } from "@/lib/i18n/dicionario";

export const metadata = { title: "Acesso negado — Admin Plataforma" };

export default async function AdminForbiddenPage() {
  // Página sem `requirePlatformAdmin()` (é o próprio destino do redirect dele)
  // — por isso resolve o idioma direto, sem passar pelo `IdiomaProvider` do
  // layout protegido. Quem chega aqui está autenticado (o guard já mandou
  // quem não está para `/login`), então `getUser()` sempre tem alguém.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const idioma = normalizarIdioma(
    (user?.user_metadata?.locale as string | undefined) ?? null,
  );

  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <Card className="w-full max-w-lg p-8 text-center">
        <h1 className="text-2xl font-medium text-text">{traduzir("Acesso negado", idioma)}</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          {traduzir(
            "Esta área é restrita a administradores da plataforma com MFA ativo. Se você acredita que isso é um erro, contate o time de operações.",
            idioma,
          )}
        </p>
        <div className="mt-6 flex justify-center gap-2">
          <Button asChild variant="outline">
            <Link href="/">{traduzir("Início", idioma)}</Link>
          </Button>
          <Button asChild>
            <Link href="/app">{traduzir("Voltar para /app", idioma)}</Link>
          </Button>
        </div>
      </Card>
    </main>
  );
}
