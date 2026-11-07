"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";

/**
 * A chave da apresentação do catálogo pela IA (#3525). Vale para a empresa inteira
 * e nasce desligada: nem toda empresa vende por sequência de texto, áudio e foto.
 */
export function CatalogoDaEmpresaForm({ inicial }: { inicial: boolean }) {
  const t = useT();
  const [ligado, setLigado] = useState(inicial);
  const [isPending, startTransition] = useTransition();

  function salvar() {
    startTransition(async () => {
      try {
        await apiClient.patch("/api/v1/settings/catalogo", { apresentacao: ligado });
        toast.success(t("Catálogo salvo."));
      } catch (e) {
        showApiError(e);
      }
    });
  }

  return (
    <Card className="space-y-3 p-4">
      <h2 className="text-sm font-medium">{t("Catálogo")}</h2>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={ligado}
          onChange={(e) => setLigado(e.target.checked)}
          className="mt-1"
          data-testid="catalogo-apresentacao-ligada"
        />
        <span>
          {t("Usar a apresentação de produtos pela IA")}
          <span className="block text-xs text-muted-foreground">
            {t(
              "Cada produto pode ter uma apresentação própria, em texto ou áudio, com fotos e preço, que o atendente de IA envia em sequência. Desligar esconde a seção, mas não apaga o que já foi cadastrado.",
            )}
          </span>
        </span>
      </label>
      <Button type="button" size="sm" disabled={isPending} onClick={salvar} data-testid="catalogo-salvar">
        {t("Aplicar ajustes do catálogo")}
      </Button>
    </Card>
  );
}
