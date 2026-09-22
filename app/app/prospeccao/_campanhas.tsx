"use client";

import * as React from "react";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { apiClient } from "@/lib/api/client";
import type { MacroCategoria } from "@/lib/prospeccao/categorias";
import { CampanhaWizard } from "./_campanha-wizard";

/**
 * Aba CAMPANHAS — multi-cidades (§39 do plano).
 *
 * Cria com nome + categorias + lista de cidades; executar faz fan-out (uma
 * busca queued por cidade). Recorrência guarda a intenção (número de dias);
 * o agendador é fase futura e a tela diz isso.
 */
interface Campanha {
  id: string;
  nome: string;
  categorias: string[];
  cidades: { cidade: string; estado?: string }[];
  status: string;
  recorrencia_dias: number | null;
  ultima_execucao_at: string | null;
}

/**
 * O status da campanha nunca chega cru à tela (`rascunho`/`ativa`/`concluida`
 * são vocabulário interno, não texto para o usuário).
 */
function rotuloDaCampanha(status: string, t: (texto: string) => string): string {
  if (status === "ativa") return t("Ativa");
  if (status === "concluida") return t("Concluída");
  return t("Rascunho");
}

export function CampanhasTab({
  categorias,
  podeOperar,
}: {
  categorias: MacroCategoria[];
  podeOperar: boolean;
}) {
  const t = useT();
  const [lista, setLista] = React.useState<Campanha[] | null>(null);

  const recarregar = React.useCallback(async () => {
    try {
      const corpo = await apiClient.get<{ data: unknown }>("/api/v1/prospecting/campaigns");
      const dados = (corpo as { data?: unknown } | null)?.data;
      setLista(Array.isArray(dados) ? dados : []);
    } catch (e) {
      showApiError(e);
    }
  }, []);

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void recarregar();
  }, [recarregar]);

  async function executar(id: string) {
    try {
      const corpo = await apiClient.post<{ data: { buscas: number; sem_mapa: string[] } | null }>(
        `/api/v1/prospecting/campaigns/${id}/executar`,
        {},
      );
      const r = corpo?.data ?? { buscas: 0, sem_mapa: [] as string[] };
      toast.success(t(`${r.buscas} buscas criadas`));
      if (Array.isArray(r.sem_mapa) && r.sem_mapa.length > 0)
        toast.warning(t(`Sem mapa: ${r.sem_mapa.join(", ")}`));
      await recarregar();
    } catch (e) {
      showApiError(e);
    }
  }

  return (
    <div className="space-y-4">
      {podeOperar && (
        <CampanhaWizard categorias={categorias} aoConcluir={() => void recarregar()} />
      )}

      {lista === null ? (
        <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>
      ) : lista.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">
          {t("Nenhuma campanha ainda.")}
        </Card>
      ) : (
        <ul className="space-y-2">
          {lista.map((c) => (
            <li key={c.id} className="rounded-lg border p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <strong>{c.nome}</strong>
                <span className="text-muted-foreground">
                  {c.categorias.join(", ")} · {c.cidades.length} {t("cidades")} ·{" "}
                  {rotuloDaCampanha(c.status, t)}
                </span>
                {podeOperar && c.status !== "concluida" && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="ml-auto"
                    onClick={() => void executar(c.id)}
                  >
                    {t("Executar")}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
