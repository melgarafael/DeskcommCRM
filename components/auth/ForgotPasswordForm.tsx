"use client";

import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useTransition, useState } from "react";

import { forgotPasswordSchema, type ForgotPasswordInput } from "@/lib/auth/schemas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { requestPasswordReset } from "@/app/actions/auth/requestPasswordReset";

export function ForgotPasswordForm() {
  const [isPending, startTransition] = useTransition();
  const [serverError, setServerError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ForgotPasswordInput>({
    resolver: zodResolver(forgotPasswordSchema),
    defaultValues: { email: "" },
  });

  const onSubmit = (values: ForgotPasswordInput) => {
    setServerError(null);
    startTransition(async () => {
      const res = await requestPasswordReset(values);
      if (res.ok) {
        setSent(true);
        return;
      }
      if (res.error === "rate_limited") {
        setServerError("Muitas tentativas. Aguarde alguns minutos.");
      } else if (res.error === "validation_error") {
        setServerError("Email inválido. Confira o campo.");
      } else {
        setServerError("Não foi possível enviar o e-mail. Tente novamente.");
      }
    });
  };

  if (sent) {
    return (
      <div
        className="space-y-2 rounded-md border bg-muted/40 px-4 py-6 text-center"
        role="status"
      >
        <p className="text-sm font-medium">Verifique seu e-mail</p>
        <p className="text-sm text-muted-foreground">
          Se existir uma conta com esse e-mail, enviamos um link para redefinir a
          senha.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
      <div className="space-y-1.5">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          autoComplete="email"
          autoFocus
          aria-invalid={errors.email ? true : undefined}
          {...register("email")}
        />
        {errors.email && (
          <p className="text-xs text-destructive">{errors.email.message}</p>
        )}
      </div>
      {serverError && (
        <div
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          role="alert"
        >
          {serverError}
        </div>
      )}
      <Button type="submit" className="w-full" disabled={isPending}>
        {isPending ? "Enviando..." : "Enviar link de redefinição"}
      </Button>
    </form>
  );
}
