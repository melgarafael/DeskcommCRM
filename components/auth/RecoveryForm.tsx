"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useRecoveryCode as submitRecoveryCode } from "@/app/actions/auth/useRecoveryCode";

interface RecoveryFormProps {
  next?: string;
}

export function RecoveryForm({ next }: RecoveryFormProps) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const normalizedCode = code.trim().toUpperCase();
    if (!/^[A-Z0-9]{8}$/.test(normalizedCode)) {
      setError("Código inválido ou já utilizado.");
      return;
    }
    startTransition(async () => {
      const res = await submitRecoveryCode({ email, code: normalizedCode }, next);
      if (!res) return; // server-side redirect on success
      if (res.error === "service_unavailable") {
        setError("Serviço de recuperação indisponível. Contate o administrador.");
      } else {
        setError("Código inválido ou já utilizado.");
      }
    });
  };

  return (
    <form method="post" onSubmit={onSubmit} className="space-y-4" noValidate>
      <div className="space-y-1.5">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          autoComplete="email"
          autoFocus
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="recovery-code">Código de recuperação</Label>
        <Input
          id="recovery-code"
          inputMode="text"
          autoComplete="one-time-code"
          maxLength={8}
          required
          placeholder="ABCD2345"
          className="font-mono uppercase tracking-widest"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
        />
        <p className="text-xs text-muted-foreground">
          Use um dos 10 códigos que você salvou ao configurar a verificação em duas etapas.
        </p>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </div>
      )}

      <Button type="submit" className="w-full" disabled={isPending}>
        {isPending ? "A validar..." : "Recuperar acesso"}
      </Button>
    </form>
  );
}
