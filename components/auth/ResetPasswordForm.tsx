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
import { Eye, EyeSlash } from "@/lib/ui/icons";

const PASSWORD_REQUIREMENTS = [
  { label: "8 ou mais caracteres", test: (value: string) => value.length >= 8 },
  { label: "Uma letra", test: (value: string) => /[A-Za-zÀ-ÿ]/.test(value) },
  { label: "Um número", test: (value: string) => /[0-9]/.test(value) },
  { label: "Um símbolo", test: (value: string) => /[^A-Za-zÀ-ÿ0-9\s]/.test(value) },
] as const;

function PasswordStrength({ password }: { password: string }) {
  const t = useT();
  const met = PASSWORD_REQUIREMENTS.map((requirement) => requirement.test(password));
  const score = met.filter(Boolean).length;
  const label = ["Muito fraca", "Fraca", "Razoável", "Boa", "Forte"][score] ?? "Muito fraca";
  const barColor = [
    "bg-muted",
    "bg-destructive",
    "bg-warning",
    "bg-info",
    "bg-success",
  ][score] ?? "bg-muted";

  return (
    <div className="space-y-2 pt-1" aria-live="polite">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="text-muted-foreground">{t("Força da senha")}</span>
        <span className="font-medium" data-testid="password-strength-label">
          {t(label)}
        </span>
      </div>
      <div
        className="grid grid-cols-4 gap-1"
        role="meter"
        aria-label={t("Força da senha")}
        aria-valuemin={0}
        aria-valuemax={4}
        aria-valuenow={score}
        aria-valuetext={t(label)}
      >
        {PASSWORD_REQUIREMENTS.map((requirement, index) => (
          <span
            key={requirement.label}
            className={`h-1.5 rounded-full ${index < score ? barColor : "bg-muted"}`}
          />
        ))}
      </div>
      <ul className="grid gap-1 text-xs sm:grid-cols-2">
        {PASSWORD_REQUIREMENTS.map((requirement, index) => (
          <li
            key={requirement.label}
            className={
              met[index] ? "text-success-fg" : "text-muted-foreground"
            }
          >
            <span aria-hidden>{met[index] ? "✓" : "•"}</span> {t(requirement.label)}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ResetPasswordForm() {
  const t = useT();
  const [isPending, startTransition] = useTransition();
  const [serverError, setServerError] = useState<string | null>(null);
  const [needsMfa, setNeedsMfa] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showPasswordConfirm, setShowPasswordConfirm] = useState(false);

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<ResetPasswordInput>({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: { password: "", password_confirm: "", mfa_code: "" },
  });
  const password = watch("password");

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
    <form
      method="post"
      onSubmit={handleSubmit(onSubmit)}
      className="space-y-4"
      autoComplete="on"
      noValidate
    >
      <div className="space-y-1.5">
        <Label htmlFor="password">{t("Nova senha")}</Label>
        <div className="relative">
          <Input
            id="password"
            type={showPassword ? "text" : "password"}
            autoComplete="new-password"
            autoFocus
            className="pr-12"
            aria-invalid={errors.password ? true : undefined}
            {...register("password")}
          />
          <button
            type="button"
            className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-500"
            aria-label={t(showPassword ? "Ocultar nova senha" : "Mostrar nova senha")}
            aria-pressed={showPassword}
            onClick={() => setShowPassword((visible) => !visible)}
          >
            {showPassword ? <EyeSlash size={20} aria-hidden /> : <Eye size={20} aria-hidden />}
          </button>
        </div>
        {errors.password && (
          <p className="text-xs text-destructive">{t(errors.password.message ?? "")}</p>
        )}
        <PasswordStrength password={password} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="password_confirm">{t("Confirmar nova senha")}</Label>
        <div className="relative">
          <Input
            id="password_confirm"
            type={showPasswordConfirm ? "text" : "password"}
            autoComplete="new-password"
            className="pr-12"
            aria-invalid={errors.password_confirm ? true : undefined}
            {...register("password_confirm")}
          />
          <button
            type="button"
            className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-500"
            aria-label={t(
              showPasswordConfirm ? "Ocultar confirmação da senha" : "Mostrar confirmação da senha",
            )}
            aria-pressed={showPasswordConfirm}
            onClick={() => setShowPasswordConfirm((visible) => !visible)}
          >
            {showPasswordConfirm ? (
              <EyeSlash size={20} aria-hidden />
            ) : (
              <Eye size={20} aria-hidden />
            )}
          </button>
        </div>
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
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
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
