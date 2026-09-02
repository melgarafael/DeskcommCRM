"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";

import { TOTPInput } from "@/components/auth/TOTPInput";
import { Button } from "@/components/ui/button";
import { verifyMfa } from "@/app/actions/auth/verifyMfa";

interface MfaFormProps {
  next?: string;
}

export function MfaForm({ next }: MfaFormProps) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (!locked || secondsLeft <= 0) return;
    const t = setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) {
          setLocked(false);
          setError(null);
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [locked, secondsLeft]);

  const submit = (codeArg?: string) => {
    const finalCode = codeArg ?? code;
    if (finalCode.length !== 6 || locked) return;
    setError(null);
    startTransition(async () => {
      const res = await verifyMfa(finalCode, next);
      if (!res) return; // server-side redirect on success
      if (res.error === "mfa_locked") {
        setLocked(true);
        setSecondsLeft(res.retry_in_seconds ?? 60);
        setError(
          `Muitas tentativas. Aguarde ${res.retry_in_seconds ?? 60}s e tente novamente.`,
        );
        setCode("");
      } else {
        setError("Código inválido. Tente novamente.");
        setCode("");
      }
    });
  };

  const recoveryHref = next
    ? `/login/recovery?next=${encodeURIComponent(next)}`
    : "/login/recovery";

  return (
    <form
      // Ver a nota nos outros formulários de autenticação: sem JavaScript o
      // submit nativo é GET, e o código de verificação iria para a query
      // string — histórico, log do servidor e Referer.
      method="post"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="space-y-6"
      noValidate
    >
      <TOTPInput
        value={code}
        onChange={setCode}
        onComplete={(c) => submit(c)}
        disabled={isPending || locked}
        autoFocus
        hasError={!!error}
      />

      {error && (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-center text-sm text-destructive"
        >
          {locked && secondsLeft > 0
            ? `Muitas tentativas. Tente novamente em ${secondsLeft}s.`
            : error}
        </div>
      )}

      <Button
        type="submit"
        className="w-full"
        disabled={isPending || locked || code.length !== 6}
      >
        {isPending ? "A verificar..." : "Verificar"}
      </Button>

      <div className="text-center text-sm">
        <Link href={recoveryHref} className="text-muted-foreground underline-offset-4 hover:underline">
          Perdi acesso ao autenticador
        </Link>
      </div>
    </form>
  );
}
