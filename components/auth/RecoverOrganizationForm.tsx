"use client";

import { useState, useTransition } from "react";

import { recoverOrganization } from "@/app/actions/auth/recoverOrganization";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const MENSAGENS: Record<string, string> = {
  validation_error: "Informe um nome de empresa com 2 a 120 caracteres.",
  rate_limited: "Muitas tentativas. Aguarde alguns minutos antes de tentar novamente.",
  invite_pending: "Esta conta tem um convite pendente ou inválido. Use o link do convite ou peça um novo ao administrador.",
  provision_failed: "Não foi possível concluir a organização agora. Tente novamente ou contate o administrador da instalação.",
};

export function RecoverOrganizationForm() {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await recoverOrganization(name);
      if (!result.ok) {
        setError(
          MENSAGENS[result.error] ??
            "Não foi possível concluir a organização agora. Tente novamente ou contate o administrador da instalação.",
        );
      }
    });
  }

  return (
    <form className="space-y-4" onSubmit={submit} noValidate>
      <div className="space-y-1.5">
        <Label htmlFor="recovery-org-name">Nome da empresa</Label>
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
        {isPending ? "Preparando seu ambiente…" : "Continuar para o onboarding"}
      </Button>
    </form>
  );
}
