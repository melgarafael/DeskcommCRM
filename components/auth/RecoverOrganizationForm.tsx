"use client";

import { useState, useTransition } from "react";

import { useT } from "@/hooks/i18n/useT";
import { recoverOrganization } from "@/app/actions/auth/recoverOrganization";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * As frases em português são as CHAVES do dicionário — a mesma convenção do
 * resto da casa (`lib/i18n/dicionario.ts`). Passar por `t()` na hora de exibir é
 * o que separa "acrescentei um idioma" de "mudei a tela de quem já usava".
 */
const MENSAGENS: Record<string, string> = {
  validation_error: "Informe um nome de empresa com 2 a 120 caracteres.",
  rate_limited: "Muitas tentativas. Aguarde alguns minutos antes de tentar novamente.",
  invite_pending:
    "Esta conta tem um convite pendente ou inválido. Use o link do convite ou peça um novo ao administrador.",
  provision_failed:
    "Não foi possível concluir a organização agora. Tente novamente ou contate o administrador da instalação.",
};

/**
 * `nomeSugerido` é o nome de empresa que a pessoa digitou no CADASTRO e que
 * viajou até aqui pelo `user_metadata` — o mesmo canal que `/auth/confirm` usa
 * para provisionar. Ele só semeia o campo: quem valida continua sendo o Zod da
 * action, e a pessoa pode trocar antes de enviar. Sem isto, quem cai na
 * recuperação precisa digitar de novo um dado que o sistema já tem, no momento
 * em que ela está mais propensa a desistir.
 */
export function RecoverOrganizationForm({ nomeSugerido }: { nomeSugerido?: string }) {
  const t = useT();
  const [name, setName] = useState(nomeSugerido ?? "");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await recoverOrganization(name);
      // O caminho de sucesso não volta: a action redireciona para o onboarding.
      if (!result.ok) setError(t(MENSAGENS[result.error] ?? MENSAGENS.provision_failed!));
    });
  }

  return (
    <form method="post" className="space-y-4" onSubmit={submit} noValidate>
      <div className="space-y-1.5">
        <Label htmlFor="recovery-org-name">{t("Nome da empresa")}</Label>
        <Input
          id="recovery-org-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoComplete="organization"
          autoFocus
          disabled={isPending}
          aria-invalid={Boolean(error)}
        />
      </div>
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      <Button className="w-full" type="submit" disabled={isPending || name.trim().length < 2}>
        {isPending ? t("Preparando seu ambiente…") : t("Continuar para o onboarding")}
      </Button>
    </form>
  );
}
