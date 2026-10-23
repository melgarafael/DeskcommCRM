"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { useT } from "@/hooks/i18n/useT";
import { useTelefoneExemplo } from "@/hooks/contacts/useTelefoneExemplo";

/**
 * Both entry points share the form; the parent keeps polling for WORKING.
 *
 * O exemplo do telefone é do país da organização (`perfil.telefoneExemplo`), não « +55 » em duro.
 * O onboarding, que não tem `AuthProvider`, o entrega por `telefoneExemplo`; Conexões o lê do contexto.
 */
export function PairingOptions({
  sessionId,
  qr,
  telefoneExemplo,
}: {
  sessionId: string;
  qr: ReactNode;
  telefoneExemplo?: string;
}) {
  const t = useT();
  const exemploDoPais = useTelefoneExemplo();
  const id = useId();
  const [mode, setMode] = useState<"qr" | "code">("qr");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  async function requestCode() {
    if (busy || cooldown > 0) return;
    const current = ++generation.current;
    setBusy(true);
    setError(null);
    setCode(null);
    try {
      const result = await apiClient.post<{ data: { code: string } }>(
        `/api/v1/channel-sessions/${sessionId}/pairing-code`,
        { phone_number: phone },
        { timeoutMs: 45_000 },
      );
      if (generation.current !== current) return;
      setCode(result.data.code);
      setCooldown(30);
    } catch (err) {
      if (generation.current !== current) return;
      setError(
        err instanceof ApiError
          ? err.message
          : t("Não foi possível gerar o código. Tente novamente."),
      );
      setCooldown(30);
    } finally {
      if (generation.current === current) setBusy(false);
    }
  }
  return (
    <div className="w-full space-y-4">
      <div className="flex justify-center gap-2" role="group" aria-label={t("Forma de conectar")}>
        <Button
          type="button"
          variant={mode === "qr" ? "default" : "outline"}
          aria-pressed={mode === "qr"}
          disabled={busy}
          onClick={() => {
            setMode("qr");
            setCode(null);
            setError(null);
          }}
        >
          {t("QR Code")}
        </Button>
        <Button
          type="button"
          variant={mode === "code" ? "default" : "outline"}
          aria-pressed={mode === "code"}
          disabled={busy}
          onClick={() => setMode("code")}
        >
          {t("Conectar por código")}
        </Button>
      </div>
      {mode === "qr" ? (
        <div className="flex justify-center">{qr}</div>
      ) : (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void requestCode();
          }}
        >
          <label htmlFor={id} className="block text-sm font-medium">
            {t("Telefone com código do país e DDD")}
          </label>
          <Input
            id={id}
            type="tel"
            autoComplete="tel"
            placeholder={telefoneExemplo ?? exemploDoPais}
            required
            maxLength={32}
            value={phone}
            disabled={busy}
            onChange={(event) => {
              setPhone(event.target.value);
              setCode(null);
              setError(null);
            }}
          />
          <Button
            type="submit"
            disabled={busy || cooldown > 0 || phone.replace(/\D/g, "").length < 8}
          >
            {busy
              ? t("Gerando código…")
              : cooldown > 0
                ? `${t("Aguarde")} ${cooldown}s`
                : code
                  ? t("Gerar outro código")
                  : t("Gerar código")}
          </Button>
          {error && (
            <p role="alert" className="text-sm text-error-fg">
              {error}
            </p>
          )}
          {code && (
            <div role="status" className="space-y-2 rounded-md border bg-muted/40 p-4 text-center">
              <p
                className="font-mono text-2xl font-semibold tracking-widest"
                aria-label={t("Código de pareamento")}
              >
                {code}
              </p>
              <p className="text-xs text-muted-foreground">
                {t("Aguardando a confirmação no celular. Se o código expirar, gere outro.")}
              </p>
            </div>
          )}
          <p className="text-sm text-muted-foreground">
            {t(
              "No celular: WhatsApp → Aparelhos conectados → Conectar um aparelho → Conectar com número de telefone. Digite o código mostrado aqui.",
            )}
          </p>
          <p className="text-xs text-muted-foreground">
            {t("Se essa opção não aparecer no celular, use o QR Code.")}
          </p>
        </form>
      )}
    </div>
  );
}
