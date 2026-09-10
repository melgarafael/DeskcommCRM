import Link from "next/link";

import { SignupForm } from "@/components/auth/SignupForm";
import { Button } from "@/components/ui/button";
import { branding } from "@/lib/branding";
import { verifyInviteToken } from "@/lib/auth/invite-token";
import { modoDeCadastro } from "@/lib/auth/politica-de-cadastro";
import { createClient } from "@/lib/supabase/server";
import { normalizarIdioma } from "@/lib/i18n/idiomas";
import { traduzir } from "@/lib/i18n/dicionario";

export const metadata = { title: "Criar conta" };

/**
 * Aceita `?invite=<token>`: é o caminho de quem foi convidado e ainda não tem
 * conta. Sem isso, essa pessoa criava uma conta comum, e o provisionamento —
 * sem encontrar vínculo nenhum — abria uma organização e a tornava admin dela.
 *
 * O token só é lido aqui para MONTAR a tela (esconder o nome da empresa, travar
 * o e-mail). Quem decide o que ele vale é o servidor, duas vezes: ao criar a
 * conta e ao confirmar o e-mail.
 *
 * ── A recusa por política (migration 0233) ──────────────────────────────────
 *
 * Quando a instalação está em `so_convite`, esta tela RECUSA em vez de mostrar
 * o formulário — mas só nesse modo, e só sem convite válido. Ela é a SUPERFÍCIE
 * da recusa, nunca a autoridade: `signUp()` e `/auth/confirm` recusam por conta
 * própria, porque esta tela é adulterável e a server action é chamável direto.
 *
 * Por que uma tela e não um 403 do proxy: um 403 cru não tem marca, não tem
 * idioma e não tem saída — é o `return` mudo que o invariante 6(c) do Sistema
 * Vivo proíbe, e é péssima primeira impressão de um produto que se vende pela
 * instalação. Medido: a regra de nginx que fazia isso numa instalação real
 * barrou junto o `/signup?invite=…`, porque proxy não sabe o que é um convite.
 */
export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ invite?: string }>;
}) {
  const { invite } = await searchParams;
  const payload = invite ? verifyInviteToken(invite) : null;
  const convite = invite && payload ? { token: invite, email: payload.email } : undefined;
  const conviteExpirado = Boolean(invite) && !payload;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const idioma = normalizarIdioma(
    (user?.user_metadata?.locale as string | undefined) ?? null,
  );
  const t = (texto: string) => traduzir(texto, idioma);

  // Convite VÁLIDO passa em qualquer modo — é o ponto inteiro do convite.
  const soPorConvite = !convite && (await modoDeCadastro()) === "so_convite";

  if (soPorConvite) {
    return (
      <div className="space-y-6 text-center">
        <div className="space-y-1.5">
          <h1 className="text-2xl font-semibold tracking-tight">
            {t("Cadastro apenas por convite")}
          </h1>
          <p className="text-sm text-muted-foreground">
            {conviteExpirado
              ? t(
                  "Esse convite expirou ou não é mais válido. Peça um novo a quem te convidou — esta instalação não aceita cadastro sem convite.",
                )
              : t(
                  "Esta instalação não aceita cadastro aberto. Se você foi convidado, use o link que chegou no seu e-mail — ele já vem com o convite.",
                )}
          </p>
        </div>
        <Button asChild className="w-full">
          <Link href="/login">{t("Entrar")}</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1.5 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">{t("Criar conta")}</h1>
        <p className="text-sm text-muted-foreground">
          {convite
            ? t("Crie sua senha para entrar na empresa que te convidou")
            : `${t("Comece a usar o")} ${branding().name} ${t("em minutos")}`}
        </p>
      </div>

      {conviteExpirado && (
        <p
          role="alert"
          className="rounded-md border border-amber-300/60 bg-amber-50 px-4 py-3 text-sm dark:border-amber-500/30 dark:bg-amber-950/20"
        >
          {t(
            "Esse convite expirou ou não é mais válido. Peça um novo a quem te convidou — criar uma conta agora abriria uma empresa nova, e não é isso que você quer.",
          )}
        </p>
      )}

      <SignupForm convite={convite} />

      <p className="text-center text-sm text-muted-foreground">
        {t("Já tem conta?")}{" "}
        <Link href="/login" className="font-medium text-foreground underline underline-offset-4">
          {t("Entrar")}
        </Link>
      </p>
    </div>
  );
}
