"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";

export function ReprocessarClique({ clickId, idioma }: { clickId: string; idioma: Idioma }) {
  const [pendente, iniciar] = useTransition();
  const router = useRouter();
  const t = (texto: string) => traduzir(texto, idioma);
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={pendente}
      onClick={() =>
        iniciar(async () => {
          try {
            const resposta = await fetch(
              `/api/v1/conversions/meta-clicks/${encodeURIComponent(clickId)}/retry`,
              { method: "POST" },
            );
            if (!resposta.ok) throw new Error();
            const body = await resposta.json();
            toast.success(
              t(
                body.data?.queued
                  ? "Reprocessamento agendado. Acompanhe o resultado nesta tela."
                  : "Não há novo envio a agendar. Atualizamos a lista.",
              ),
            );
            router.refresh();
          } catch {
            toast.error(t("Não foi possível reprocessar. Confira sua sessão e tente novamente."));
          }
        })
      }
    >
      {t(pendente ? "Agendando..." : "Verificar ou tentar novamente")}
    </Button>
  );
}
