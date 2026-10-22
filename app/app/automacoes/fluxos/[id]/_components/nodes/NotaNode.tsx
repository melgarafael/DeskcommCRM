"use client";

import type { NodeProps } from "@xyflow/react";
import { useEffect, useState } from "react";

import type { RFNode } from "@/lib/followup/graph-mappers";
import { useT } from "@/hooks/i18n/useT";
import { X } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

import { useAcoesDoMapa } from "../AcoesDoMapa";

/**
 * A nota do mapa (Automações, estilo ManyChat): um papel amarelo com texto
 * livre para explicar a lógica do fluxo. Sem alças — nenhuma seta entra nem sai
 * dela, e o motor nunca a lê (ela mora em `settings.notas`, não em `nodes`).
 *
 * O texto é editado no próprio cartão. `nodrag` no campo para o arrasto do
 * mouse selecionar texto em vez de mover a nota; a nota se move pela borda.
 */
export function NotaNode({ id, data, selected }: NodeProps<RFNode>) {
  const t = useT();
  const acoes = useAcoesDoMapa();
  const salvo = (data.config as unknown as { texto?: string }).texto ?? "";
  const [texto, setTexto] = useState(salvo);
  useEffect(() => setTexto(salvo), [salvo]);

  return (
    <div
      className={cn(
        "w-56 rounded-md border border-warning bg-warning-bg p-2 shadow-sm",
        selected && "ring-2 ring-warning",
      )}
      data-testid={`nota-${id}`}
    >
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-wide text-warning-fg">
          {t("Nota")}
        </span>
        {acoes && (
          <button
            type="button"
            className="nodrag rounded-sm p-0.5 text-warning-fg hover:bg-surface"
            aria-label={t("Remover nota")}
            onClick={(e) => {
              e.stopPropagation();
              acoes.removerNota(id);
            }}
          >
            <X size={12} aria-hidden />
          </button>
        )}
      </div>
      <textarea
        className="nodrag nowheel min-h-16 w-full resize-y bg-transparent text-xs text-text outline-hidden placeholder:text-text-muted"
        value={texto}
        maxLength={1000}
        placeholder={t("Escreva aqui para explicar este trecho do fluxo")}
        aria-label={t("Texto da nota")}
        onChange={(e) => {
          setTexto(e.target.value);
          acoes?.editarNota(id, e.target.value);
        }}
      />
    </div>
  );
}
