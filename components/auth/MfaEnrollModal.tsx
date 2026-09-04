"use client";

import { useEffect, useState, useTransition } from "react";

import { useT } from "@/hooks/i18n/useT";
import { Button } from "@/components/ui/button";
import { TOTPInput } from "@/components/auth/TOTPInput";
import { RecoveryCodesPanel } from "@/components/auth/RecoveryCodesPanel";
import { enrollMfa } from "@/app/actions/auth/enrollMfa";
import { confirmMfaEnroll } from "@/app/actions/auth/confirmMfaEnroll";

type Step = "intro" | "scan" | "codes";

interface EnrollState {
  factor_id: string;
  qr_data_url: string;
  uri: string;
  secret: string;
}

/**
 * Three-step MFA enrollment:
 *  1. Intro / start
 *  2. QR scan + 6-digit code verification
 *  3. Recovery codes display + acknowledgement
 *
 * On completion, reloads the page so the parent layout re-evaluates the gate.
 */
export function MfaEnrollModal({ motivo = "obrigatorio" }: { motivo?: "obrigatorio" | "escolha" } = {}) {
  const t = useT();
  const [step, setStep] = useState<Step>("intro");
  const [enrollState, setEnrollState] = useState<EnrollState | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [isPending, startTransition] = useTransition();

  // Auto-start enrollment when entering scan step.
  useEffect(() => {
    if (step !== "scan" || enrollState) return;
    startTransition(async () => {
      const res = await enrollMfa();
      if (!res.ok) {
        setError(res.message ?? t("Não foi possível iniciar a configuração."));
        setStep("intro");
        return;
      }
      setEnrollState({
        factor_id: res.factor_id,
        qr_data_url: res.qr_data_url,
        uri: res.uri,
        secret: res.secret,
      });
    });
  }, [step, enrollState, t]);

  const submitCode = (codeArg?: string) => {
    if (!enrollState) return;
    const finalCode = codeArg ?? code;
    if (finalCode.length !== 6) return;
    setError(null);
    startTransition(async () => {
      const res = await confirmMfaEnroll(finalCode, enrollState.factor_id);
      if (!res.ok) {
        if (res.error === "verify_failed" || res.error === "invalid_code") {
          setError(t("Código inválido. Tente novamente."));
        } else {
          setError(res.message ?? t("Falha ao confirmar. Tente novamente."));
        }
        setCode("");
        return;
      }
      setRecoveryCodes(res.recovery_codes);
      setStep("codes");
    });
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="mfa-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div className="w-full max-w-md rounded-lg border border-border bg-background p-6 shadow-xl">
        {step === "intro" && (
          <div className="space-y-4">
            <div>
              <h2 id="mfa-title" className="text-xl font-semibold">
                {t("Configure a verificação em duas etapas")}
              </h2>
              {/*
                ⚠️ O MESMO MODAL ATENDE DOIS MOMENTOS OPOSTOS. Ele nasceu dentro
                do bloqueador de tela cheia, onde "sua conta exige" era verdade;
                reusá-lo no botão "Ativar" de Configurações fazia a tela afirmar
                uma obrigação que não existe — a pessoa está ligando a proteção
                por vontade própria. E "2FA" é jargão: o resto do produto diz
                "verificação em duas etapas".
              */}
              <p className="mt-1 text-sm text-muted-foreground">
                {motivo === "obrigatorio"
                  ? t("Esta empresa exige a verificação em duas etapas de quem administra. ")
                  : t("A cada login, além da senha, o sistema vai pedir um código de 6 dígitos. ")}
                {t(
                  "Use um aplicativo autenticador (Google Authenticator, 1Password, Authy, Bitwarden) para gerar os códigos.",
                )}
              </p>
            </div>
            {error && (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            )}
            <Button
              type="button"
              className="w-full"
              onClick={() => {
                setError(null);
                setStep("scan");
              }}
              disabled={isPending}
            >
              {t("Iniciar configuração")}
            </Button>
          </div>
        )}

        {step === "scan" && (
          <div className="space-y-5">
            <div>
              <h2 id="mfa-title" className="text-xl font-semibold">
                {t("Escaneie o QR code")}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {t("Abra seu app autenticador, adicione uma nova conta e digite o código de 6 dígitos abaixo.")}
              </p>
            </div>

            {!enrollState ? (
              <div className="flex h-60 items-center justify-center text-sm text-muted-foreground">
                {t("Gerando QR code...")}
              </div>
            ) : (
              <>
                <div className="flex justify-center">
                  {/* eslint-disable-next-line @next/next/no-img-element -- inline data URL, no benefit from next/image optimization */}
                  <img
                    src={enrollState.qr_data_url}
                    alt={t("QR code para configurar autenticador")}
                    width={240}
                    height={240}
                    className="rounded-md border border-border bg-white p-2"
                  />
                </div>
                <details className="text-xs text-muted-foreground">
                  <summary className="cursor-pointer">
                    {t("Não consegue escanear? Digite o código manual")}
                  </summary>
                  <code className="mt-2 block break-all rounded-md bg-muted p-2 font-mono">
                    {enrollState.secret}
                  </code>
                </details>

                <div className="space-y-3">
                  <p className="text-center text-sm font-medium">
                    {t("Digite o código de 6 dígitos")}
                  </p>
                  <TOTPInput
                    value={code}
                    onChange={setCode}
                    onComplete={(c) => submitCode(c)}
                    disabled={isPending}
                    autoFocus
                    hasError={!!error}
                  />
                  {error && (
                    <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-center text-sm text-destructive">
                      {error}
                    </div>
                  )}
                  <Button
                    type="button"
                    className="w-full"
                    disabled={isPending || code.length !== 6}
                    onClick={() => submitCode()}
                  >
                    {isPending ? t("Verificando...") : t("Confirmar")}
                  </Button>
                </div>
              </>
            )}
          </div>
        )}

        {step === "codes" && recoveryCodes && (
          <div className="space-y-4">
            <div>
              <h2 id="mfa-title" className="text-xl font-semibold">
                {t("Códigos de recuperação")}
              </h2>
            </div>
            <RecoveryCodesPanel
              codes={recoveryCodes}
              onAcknowledge={() => {
                window.location.reload();
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
