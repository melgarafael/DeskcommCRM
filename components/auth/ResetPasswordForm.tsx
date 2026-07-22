"use client";

import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useTransition, useState } from "react";

import { resetPasswordSchema, type ResetPasswordInput } from "@/lib/auth/schemas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { updatePassword } from "@/app/actions/auth/updatePassword";

export function ResetPasswordForm() {
  const [isPending, startTransition] = useTransition();
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ResetPasswordInput>({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: { password: "", password_confirm: "" },
  });

  const onSubmit = (values: ResetPasswordInput) => {
    setServerError(null);
    startTransition(async () => {
      // Sucesso redireciona server-side para /login?reset=success.
      const res = await updatePassword(values);
      if (!res) return;
      if (res.error === "session_expired") {
        setServerError(
          "Sessão de redefinição expirada. Peça um novo link em Recuperar senha.",
        );
      } else if (res.error === "same_password") {
        setServerError("A nova senha precisa ser diferente da atual.");
      } else if (res.error === "validation_error") {
        setServerError("Dados inválidos. Confira os campos.");
      } else {
        setServerError("Não foi possível redefinir a senha. Tente novamente.");
      }
    });
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
      <div className="space-y-1.5">
        <Label htmlFor="password">Nova senha</Label>
        <Input
          id="password"
          type="password"
          autoComplete="new-password"
          autoFocus
          aria-invalid={errors.password ? true : undefined}
          {...register("password")}
        />
        {errors.password && (
          <p className="text-xs text-destructive">{errors.password.message}</p>
        )}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="password_confirm">Confirmar nova senha</Label>
        <Input
          id="password_confirm"
          type="password"
          autoComplete="new-password"
          aria-invalid={errors.password_confirm ? true : undefined}
          {...register("password_confirm")}
        />
        {errors.password_confirm && (
          <p className="text-xs text-destructive">{errors.password_confirm.message}</p>
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
        {isPending ? "Salvando..." : "Definir nova senha"}
      </Button>
    </form>
  );
}
