"use client";

import { useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { connectNuvemshop } from "@/app/actions/integrations/connectNuvemshop";
import {
  skipNuvemshop,
  markNuvemshopConfigured,
} from "@/app/actions/onboarding/skipWhatsapp";
import { branding } from "@/lib/branding";

export function ConnectNuvemshopClient() {
  const [pending, startTransition] = useTransition();

  return (
    <div className="space-y-4 rounded-lg border bg-background p-6">
      <p className="text-sm">
        Ao clicar em <strong>Conectar</strong>, você será redirecionado para autorizar o
        {branding().name} na sua conta Nuvemshop.
      </p>

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const res = await connectNuvemshop();
              if (res && !res.ok) {
                if (res.error === "not_configured") {
                  toast.message("Nuvemshop ainda não configurado neste ambiente.", {
                    description: "Pule por enquanto e configure depois em Integrações.",
                  });
                } else {
                  toast.error(`Erro: ${res.error}`);
                }
              }
            })
          }
        >
          Conectar
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={() => startTransition(() => void markNuvemshopConfigured())}
        >
          Já conectei
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={pending}
          onClick={() => startTransition(() => void skipNuvemshop())}
        >
          Pular por enquanto
        </Button>
      </div>
    </div>
  );
}
