"use client";

import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";

import { useT } from "@/hooks/i18n/useT";
import { resetPasswordSchema, type ResetPasswordInput } from "@/lib/auth/schemas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trocarSenhaProvisoria } from "@/app/actions/auth/trocarSenhaProvisoria";
import { AvisoSemResposta, useEnvioComTeto } from "@/components/auth/teto-da-espera";
import { Eye, EyeSlash } from "@/lib/ui/icons";
import { PasswordStrength } from "@/components/auth/PasswordStrength";

/**
 * A tela do primeiro acesso (#3876): a pessoa entrou com a senha que quem
 * administra definiu e escolhe a dela antes de usar o produto.
 *
 * Usa `resetPasswordSchema` — a MESMA régua da recuperação de senha — e não
 * repete as regras: senha fraca recusada aqui é a mesma que a recuperação
 * recusaria, e a mensagem vem do schema.
 *
 * Não há campo de MFA: a conta nasceu agora, com a senha definida por quem
 * administra, e o GoTrue só exige AAL2 de quem já cadastrou um fator.
 */
export function TrocaSenhaProvisoriaForm() {
  const t = useT();
  const { pendente: isPending, semResposta, enviar } = useEnvioComTeto();
  const [serverError, setServerError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [showPasswordConfirm, setShowPasswordConfirm] = useState(false);

  const {
    register,
    handleSubmit,
    control,
    formState: { errors },
  } = useForm<ResetPasswordInput>({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: { password: "", password_confirm: "", mfa_code: "" },
  });
  const password = useWatch({ control, name: "password" });

  const onSubmit = (values: ResetPasswordInput) => {
    setServerError(null);
    // Sucesso redireciona server-side para /app, já destravado.
    void enviar(() => trocarSenhaProvisoria(values), (res) => {
      if (!res) return;
      if (res.error === "same_password") {
        setServerError(t("A senha nova precisa ser diferente da que você usou para entrar."));
      } else if (res.error === "not_required") {
        setServerError(t("Sua senha já foi trocada. Entre novamente com a senha nova."));
      } else if (res.error === "session_expired") {
        setServerError(t("Sua sessão expirou. Entre novamente com a senha que você recebeu."));
      } else if (res.error === "validation_error") {
        setServerError(t("Dados inválidos. Confira os campos."));
      } else {
        setServerError(t("Não foi possível trocar a senha agora. Tente novamente."));
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
            className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:outline-hidden focus-visible:ring-inset"
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
            className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:outline-hidden focus-visible:ring-inset"
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
      {serverError && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
          {serverError}
        </div>
      )}
      {semResposta && <AvisoSemResposta />}
      <Button type="submit" className="w-full" disabled={isPending}>
        {isPending ? t("Salvando...") : t("Trocar senha e entrar")}
      </Button>
    </form>
  );
}
