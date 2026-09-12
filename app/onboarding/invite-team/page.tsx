import { getSmtpConfig } from "@/lib/email/config";
import { InviteTeamForm } from "./_form";
import { requireAuth } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

export default async function InviteTeamPage() {
  const user = await requireAuth();
  const idioma = user.idioma;
  const smtp = await getSmtpConfig();
  const emailReady = Boolean(smtp.host && smtp.fromEmail);
  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-2xl font-semibold tracking-tight">{traduzir("Quem trabalha com ele", idioma)}</h2>
        <p className="text-sm text-muted-foreground">
          {traduzir(
            "Seu funcionário não trabalha sozinho: quando ele passar uma conversa adiante, é uma dessas pessoas que atende.",
            idioma,
          )}
        </p>
      </header>
      {!emailReady ? (
        <div className="rounded-md border border-amber-300/60 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-950/40 dark:text-amber-100">
          <p className="font-medium">{traduzir("Esta instalação ainda não envia e-mail.", idioma)}</p>
          {/*
            A frase anterior dizia que os convites ficariam "registrados
            localmente" — e isso é falso: não existe tabela de convites, o
            convite É o link assinado. Quem confiasse na frase iria procurar
            depois uma lista de pendentes que nunca existiu. E o nome da
            variável de ambiente não ajuda quem só quer chamar um colega.
          */}
          <p className="mt-1">
            {traduzir(
              "Você recebe um link para cada pessoa e manda por onde quiser — WhatsApp, e-mail, o que preferir. O link é o convite: quem abrir entra na sua empresa.",
              idioma,
            )}
          </p>
        </div>
      ) : null}
      <InviteTeamForm />
    </div>
  );
}
