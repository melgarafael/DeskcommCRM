"use client";

import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";

import { useT } from "@/hooks/i18n/useT";
import { forgotPasswordSchema, type ForgotPasswordInput } from "@/lib/auth/schemas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { requestPasswordReset } from "@/app/actions/auth/requestPasswordReset";
import { AvisoSemResposta, useEnvioComTeto } from "@/components/auth/teto-da-espera";

export function ForgotPasswordForm() {
  const t = useT();
  const { pendente: isPending, semResposta, enviar } = useEnvioComTeto();
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
    void enviar(() => requestPasswordReset(values), (res) => {
      if (res.ok) {
        setSent(true);
        return;
      }
      if (res.error === "rate_limited") {
        setServerError(t("Muitas tentativas. Aguarde alguns minutos."));
      } else if (res.error === "validation_error") {
        setServerError(t("Email inválido. Confira o campo."));
      } else if (res.error === "smtp_not_configured") {
        // #2755 — sem SMTP não há "tente novamente" que resolva: a pessoa
        // repetiria um gesto que não vai funcionar. Dizemos o que é, e quem
        // resolve é o administrador.
        //
        // #3039 — e dizemos SÓ o que esta instalação MEDE. O CRM lê o SMTP
        // dele (`lib/email/estado.ts`), não o `.env` do GoTrue: quem pôs SMTP
        // direto lá tem e-mail saindo de um CRM sem SMTP. "Não sai e-mail
        // nenhum" era mais do que a régua sabe. Este código só existe em
        // servidor único (`semSmtpNaInstalacao`), então a frase fala do SMTP
        // do CRM e da dependência que o kit sincroniza — não de todo e-mail.
        setServerError(
          t(
            "O CRM está sem SMTP configurado e, nesta instalação, o e-mail de recuperação de senha depende dele. Por isso o link não foi enviado. Contate o administrador para configurar em /admin/email.",
          ),
        );
      } else {
        setServerError(t("Não foi possível enviar o e-mail. Tente novamente."));
      }
    });
  };

  if (sent) {
    return (
      <div
        className="space-y-2 rounded-md border bg-muted/40 px-4 py-6 text-center"
        role="status"
      >
        <p className="text-sm font-medium">{t("Verifique seu e-mail")}</p>
        <p className="text-sm text-muted-foreground">
          {t("Se existir uma conta com esse e-mail, enviamos um link para redefinir a senha.")}
        </p>
      </div>
    );
  }

  return (
    <form method="post" onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
      <div className="space-y-1.5">
        <Label htmlFor="email">{t("Email")}</Label>
        <Input
          id="email"
          type="email"
          autoComplete="email"
          autoFocus
          aria-invalid={errors.email ? true : undefined}
          {...register("email")}
        />
        {errors.email && (
          <p className="text-xs text-destructive">{t(errors.email.message ?? "")}</p>
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
      {semResposta && <AvisoSemResposta />}
      <Button type="submit" className="w-full" disabled={isPending}>
        {isPending ? t("Enviando...") : t("Enviar link de redefinição")}
      </Button>
    </form>
  );
}
