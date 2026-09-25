"use client";

/**
 * ESTADO DA BASE DE CONHECIMENTO — quantos materiais estão prontos, quantos
 * ainda preparando e quantos falharam. Sem isso, "está rodando?" só tinha
 * resposta no log do contêiner.
 *
 * Lê o que a tela do acervo JÁ tem: a lista de materiais (atualizada pelo
 * realtime de `ai_knowledge_sources`) e o estado da chave
 * (`GET /api/v1/ai/knowledge/chave`). Nenhuma rota nova só para contar.
 */
import { CheckCircle2, Loader2, TriangleAlert } from "lucide-react";

import { Card } from "@/components/ui/card";
import { useT } from "@/hooks/i18n/useT";
import type { SourceRow } from "@/hooks/ai/useKnowledgeSources";

export interface ResumoDaBase {
  total: number;
  prontos: number;
  preparando: number;
  comErro: number;
}

/** Puro: a contagem que o cartão mostra, só dos materiais não arquivados. */
export function resumirBase(materiais: readonly Pick<SourceRow, "status" | "last_index_status">[]): ResumoDaBase {
  const ativos = materiais.filter((m) => m.status !== "archived");
  const contar = (...estados: Array<SourceRow["last_index_status"]>) =>
    ativos.filter((m) => estados.includes(m.last_index_status)).length;
  return {
    total: ativos.length,
    prontos: contar("success"),
    preparando: contar("indexando"),
    comErro: contar("failed", "partial"),
  };
}

export function StatusDaBase({
  materiais,
  podeIndexar,
}: {
  materiais: readonly SourceRow[];
  podeIndexar: boolean;
}) {
  const t = useT();
  const r = resumirBase(materiais);
  if (r.total === 0) return null;

  return (
    <Card className="space-y-2 p-4" data-testid="status-da-base">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-0.5">
          <h3 className="text-sm font-medium">{t("Estado da base de conhecimento")}</h3>
          <p className="text-xs text-text-muted" data-testid="status-da-base-resumo">
            {r.total} {t("materiais")} ·{" "}
            <span className="text-success-fg">
              {r.prontos} {t("prontos")}
            </span>
            {r.preparando > 0 ? (
              <>
                {" · "}
                <span className="text-foreground">
                  {r.preparando} {t("preparando")}
                </span>
              </>
            ) : null}
            {r.comErro > 0 ? (
              <>
                {" · "}
                <span className="text-warning-fg">
                  {r.comErro} {t("com erro")}
                </span>
              </>
            ) : null}
          </p>
        </div>
        {r.preparando > 0 ? (
          <span className="flex items-center gap-1 text-xs text-text-muted">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            {t("preparando o material…")}
          </span>
        ) : podeIndexar && r.comErro === 0 && r.prontos === r.total ? (
          <span className="flex items-center gap-1 text-xs text-success-fg">
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
            {t("tudo pronto")}
          </span>
        ) : null}
      </div>

      {r.comErro > 0 ? (
        <p className="flex items-start gap-1.5 text-xs text-warning-fg">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          {t(
            "Alguns materiais falharam ao preparar. O motivo está no cartão de cada um; depois de corrigir, clique em “Preparar tudo de novo”.",
          )}
        </p>
      ) : null}
    </Card>
  );
}
