"use client";

import { useState, useTransition } from "react";

import { useT } from "@/hooks/i18n/useT";
import { Button } from "@/components/ui/button";
import { signInWithGoogle } from "@/app/actions/auth/signInWithGoogle";

/**
 * O botão "Entrar com Google" — o mesmo no login e no cadastro.
 *
 * O cadastro passa `convite` porque a volta não tem como saber que a pessoa
 * veio de um convite: o Google não devolve nada nosso além do que pusermos na
 * URL de retorno (ver `lib/auth/entrada-com-google.ts`).
 *
 * No sucesso nada volta para cá — a server action redireciona o navegador para
 * o Google. O que pode voltar é a recusa, e ela é mostrada aqui mesmo, embaixo
 * do botão, para não perder o que a pessoa já tinha digitado no formulário.
 */
export function EntrarComGoogle({ next, convite }: { next?: string; convite?: string }) {
  const t = useT();
  const [isPending, startTransition] = useTransition();
  const [erro, setErro] = useState<string | null>(null);

  const onClick = () => {
    setErro(null);
    startTransition(async () => {
      const res = await signInWithGoogle({ next, convite });
      // `res` indefinido = o redirect do sucesso aconteceu (ele lança).
      if (!res) return;

      setErro(
        res.error === "google_indisponivel"
          ? t(
              "O Google não está habilitado nesta instalação. Entre com e-mail e senha, ou peça a quem administra para habilitá-lo.",
            )
          : t("Não foi possível falar com o Google agora. Tente novamente em instantes."),
      );
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <span className="h-px flex-1 bg-border" />
        <span className="text-xs uppercase tracking-wide text-muted-foreground">{t("ou")}</span>
        <span className="h-px flex-1 bg-border" />
      </div>
      {erro && (
        <div
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          role="alert"
        >
          {erro}
        </div>
      )}
      <Button
        type="button"
        variant="outline"
        className="w-full"
        disabled={isPending}
        onClick={onClick}
      >
        {isPending ? t("Abrindo o Google...") : t("Entrar com Google")}
      </Button>
    </div>
  );
}
