"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";

type Chaves = { apresentacao: boolean; capacidade: boolean };

/**
 * As chaves do catálogo que valem para a empresa inteira e nascem desligadas:
 * a apresentação pela IA (#3525), porque nem toda empresa vende por sequência de
 * texto, áudio e foto; e o campo Capacidade (#3472), porque o catálogo é o mesmo
 * para uma loja de celulares e para uma clínica. Salvar envia só a chave que
 * mudou, para a auditoria não registrar troca que não houve.
 */
export function CatalogoDaEmpresaForm({ inicial }: { inicial: Chaves }) {
  const t = useT();
  const [salvo, setSalvo] = useState(inicial);
  const [chaves, setChaves] = useState(inicial);
  const [isPending, startTransition] = useTransition();

  function salvar() {
    const mudou = Object.fromEntries(
      (Object.keys(chaves) as (keyof Chaves)[]).filter((k) => chaves[k] !== salvo[k]).map((k) => [k, chaves[k]]),
    );
    if (Object.keys(mudou).length === 0) {
      toast.success(t("Catálogo salvo."));
      return;
    }
    startTransition(async () => {
      try {
        await apiClient.patch("/api/v1/settings/catalogo", mudou);
        setSalvo(chaves);
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
          checked={chaves.apresentacao}
          onChange={(e) => setChaves((c) => ({ ...c, apresentacao: e.target.checked }))}
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
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={chaves.capacidade}
          onChange={(e) => setChaves((c) => ({ ...c, capacidade: e.target.checked }))}
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
