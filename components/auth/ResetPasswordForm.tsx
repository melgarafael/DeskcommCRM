"use client";

import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useTransition, useState } from "react";

import { useT } from "@/hooks/i18n/useT";
import { resetPasswordSchema, type ResetPasswordInput } from "@/lib/auth/schemas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { updatePassword } from "@/app/actions/auth/updatePassword";

export function ResetPasswordForm() {
  const t = useT();
  const [isPending, startTransition] = useTransition();
  const [serverError, setServerError] = useState<string | null>(null);
  const [needsMfa, setNeedsMfa] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ResetPasswordInput>({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: { password: "", password_confirm: "", mfa_code: "" },
  });

  const onSubmit = (values: ResetPasswordInput) => {
    setServerError(null);
    startTransition(async () => {
      // Sucesso redireciona server-side para /login?reset=success.
      const res = await updatePassword(values);
      if (!res) return;
      if (res.error === "mfa_required") {
        setNeedsMfa(true);
        setServerError(
          t(
            "Sua conta tem verificação em duas etapas. Digite o código de 6 dígitos do seu app autenticador para concluir.",
          ),
        );
      } else if (res.error === "mfa_invalid") {
        setNeedsMfa(true);
        setServerError(t("Código de verificação inválido. Tente de novo."));
      } else if (res.error === "session_expired") {
        setServerError(
          t("Sessão de redefinição expirada. Peça um novo link em Recuperar senha."),
        );
      } else if (res.error === "same_password") {
        setServerError(t("A nova senha precisa ser diferente da atual."));
      } else if (res.error === "validation_error") {
        setServerError(t("Dados inválidos. Confira os campos."));
      } else {
        setServerError(t("Não foi possível redefinir a senha. Tente novamente."));
      }
    });
  };

  return (
    <form method="post" onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
      <div className="space-y-1.5">
        <Label htmlFor="password">{t("Nova senha")}</Label>
        <Input
          id="password"
          type="password"
          autoComplete="new-password"
          autoFocus
          aria-invalid={errors.password ? true : undefined}
          {...register("password")}
        />
        {errors.password && (
          <p className="text-xs text-destructive">{t(errors.password.message ?? "")}</p>
        )}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="password_confirm">{t("Confirmar nova senha")}</Label>
        <Input
          id="password_confirm"
          type="password"
          autoComplete="new-password"
          aria-invalid={errors.password_confirm ? true : undefined}
          {...register("password_confirm")}
        />
        {errors.password_confirm && (
          <p className="text-xs text-destructive">{t(errors.password_confirm.message ?? "")}</p>
        )}
      </div>
      {needsMfa && (
        <div className="space-y-1.5">
          <Label htmlFor="mfa_code">{t("Código de verificação (2 etapas)")}</Label>
          <Input
            id="mfa_code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder="000000"
            autoFocus
            {...register("mfa_code")}
          />
        </div>
      )}
      {serverError && (
        <div
          className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          role={needsMfa ? "status" : "alert"}
        >
          {serverError}
        </div>
      )}
      <Button type="submit" className="w-full" disabled={isPending}>
        {isPending ? t("Salvando...") : t("Definir nova senha")}
      </Button>
    </form>
  );
}
