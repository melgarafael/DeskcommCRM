import { redirect } from "next/navigation";
import Link from "next/link";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { InboxLayout } from "@/components/inbox/InboxLayout";
import { configDeLimpezaDoAgente } from "@/lib/escalacao/limpeza-de-conversa";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string }>;
}) {
  const user = await loadAuthUser();
  if (!user) redirect("/login");
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) {
    const idioma = user.idioma;
    // As duas saídas que a frase anterior oferecia — "aceite um convite" e
    // "contate o admin" — não existem para quem INSTALOU o sistema: não há
    // convite e o admin é ele. Este é o estado terminal do primeiro acesso que
    // falhou, e o link é a única porta para fora dele.
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-sm text-muted-foreground">
        <p>
          {traduzir(
            "Você não tem nenhuma organização ativa. Configure sua organização ou aceite um convite.",
            idioma,
          )}
        </p>
        <Link className="text-primary underline underline-offset-4" href="/get-started">
          {traduzir("Configurar minha organização", idioma)}
        </Link>
      </div>
    );
  }
  const { id } = await searchParams;

  // C-104: a limpeza pelo atendente é decisão do agente publicado. Lida AQUI,
  // no servidor, para o botão nem nascer desligado — e a rota recheca a mesma
  // flag, porque esconder botão não é controle de acesso.
  const supabase = await createClient();
  const limpeza = await configDeLimpezaDoAgente(supabase, activeOrg.orgId);

  return (
    <InboxLayout
      initialSelectedId={id ?? null}
      podeLimparConversa={limpeza.permiteAtendente}
    />
  );
}
