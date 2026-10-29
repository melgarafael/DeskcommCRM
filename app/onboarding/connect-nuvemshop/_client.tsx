"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { useT } from "@/hooks/i18n/useT";
import { irAoDesafioDeMfa } from "@/lib/auth/ir-ao-desafio-de-mfa";

import { Button } from "@/components/ui/button";
import { connectNuvemshop } from "@/app/actions/integrations/connectNuvemshop";
import {
  skipNuvemshop,
  markNuvemshopConfigured,
} from "@/app/actions/onboarding/skipWhatsapp";
import { useMarcaDaInstalacao } from "@/lib/branding/contexto";

export function ConnectNuvemshopClient() {
  const t = useT();
  const [pending, startTransition] = useTransition();
  // Por PROP do servidor, nunca `branding()`: no navegador aquela função lê
  // `window.__PUBLIC_ENV__` (a marca do BANCO) e no SSR lê `process.env` (só o
  // `.env`). Renderizar o nome a partir dela faz o texto do servidor divergir do
  // hidratado — hydration mismatch. Ver `lib/branding/contexto.tsx`.
  const marca = useMarcaDaInstalacao();

  return (
    <div className="space-y-4 rounded-lg border bg-background p-6">
      <p className="text-sm">
        {t("Ao clicar em")} <strong>{t("Conectar")}</strong> {t("você será redirecionado para autorizar o")}{" "}
        {marca.name} {t("na sua conta Nuvemshop.")}
      </p>

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const res = await connectNuvemshop();
              if (res && !res.ok) {
                if (res.error === "mfa_required") {
                  irAoDesafioDeMfa();
                } else if (res.error === "not_configured") {
                  toast.message(t("Nuvemshop ainda não configurado neste ambiente."), {
                    description: t("Pule por enquanto e configure depois em Integrações."),
                  });
                } else {
                  toast.error(`${t("Erro:")} ${res.error}`);
                }
              }
            })
          }
        >
          {t("Conectar")}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={() => startTransition(() => void markNuvemshopConfigured())}
        >
          {t("Já conectei")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={pending}
          onClick={() => startTransition(() => void skipNuvemshop())}
        >
          {t("Pular por enquanto")}
        </Button>
      </div>
    </div>
  );
}
