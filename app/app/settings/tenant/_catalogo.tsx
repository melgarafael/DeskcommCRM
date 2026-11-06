"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";

/**
 * A chave do campo Capacidade (#3472). Vale para a empresa inteira e nasce
 * desligada: o catálogo é o mesmo para uma loja de celulares e para uma clínica.
 */
export function CatalogoDaEmpresaForm({ inicial }: { inicial: boolean }) {
  const t = useT();
  const [ligado, setLigado] = useState(inicial);
  const [isPending, startTransition] = useTransition();

  function salvar() {
    startTransition(async () => {
      try {
        await apiClient.patch("/api/v1/settings/catalogo", { capacidade: ligado });
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
          data-testid="catalogo-capacidade-ligada"
        />
        <span>
          {t("Usar o campo Capacidade nos produtos")}
          <span className="block text-xs text-muted-foreground">
            {t(
              "Mostra o campo em Produtos e na planilha, para 128GB, 1TB ou 500ml, e o atendente de IA passa a procurar por ele. Desligar esconde o campo, mas não apaga o que já foi cadastrado.",
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
