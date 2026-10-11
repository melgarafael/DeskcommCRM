"use client";

import { Button } from "@/components/ui/button";
import { acoesQueFechamLaco, MENSAGEM_DO_LACO_DE_LEAD } from "@/lib/schemas/webhooks";
import { cn } from "@/lib/utils";
import { useT } from "@/hooks/i18n/useT";
import { ACTION_LABELS, type ActionType } from "@/app/app/webhooks/_components/labels";

import { ACOES_DA_PALETA, VISUAL_DAS_CONDICOES, VISUAL_DA_ACAO, type VisualDaCaixa } from "./visual";

export const DND_DA_AUTOMACAO = "application/x-automacao-caixa";
export type ItemDaPaleta = ActionType | "condicoes";

interface Props {
  evento: string;
  temCondicoes: boolean;
  onAdd: (tipo: ItemDaPaleta) => void;
  variant?: "desktop" | "mobile";
}

/**
 * A paleta do designer — o mesmo formato da do construtor de follow-up. As
 * ações são as MESMAS do seletor "Adicionar ação" do editor em lista, e com a
 * mesma trava: nos gatilhos de encerramento e responsável, mover o lead e
 * atribuir responsável ficam desabilitados (fechariam laço, #1528).
 */
export function PaletaDaAutomacao({ evento, temCondicoes, onAdd, variant = "desktop" }: Props) {
  const t = useT();
  const mobile = variant === "mobile";
  const item = (tipo: ItemDaPaleta, visual: VisualDaCaixa, titulo: string, travado: string | null) => {
    const Icone = visual.icon;
    return (
      <Button
        key={tipo}
        type="button"
        variant="secondary"
        size="sm"
        className="h-auto min-h-9 justify-start gap-2 py-1.5 text-left"
        draggable={!travado}
        disabled={!!travado}
        title={travado ?? titulo}
        onDragStart={(e) => {
          e.dataTransfer.setData(DND_DA_AUTOMACAO, tipo);
          e.dataTransfer.effectAllowed = "move";
        }}
        onClick={() => onAdd(tipo)}
        data-testid={`paleta-${tipo}`}
      >
        <span className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded-full", visual.chipClassName)}>
          <Icone size={14} aria-hidden />
        </span>
        <span className="whitespace-normal">{t(visual.paleta)}</span>
      </Button>
    );
  };
  return (
    <aside
      className={cn(
        "flex flex-col gap-1.5 overflow-y-auto p-3",
        mobile ? "h-full w-full" : "hidden w-56 shrink-0 border-r border-border bg-surface lg:flex",
      )}
      data-testid="paleta-da-automacao"
    >
      <h2 className="px-1 pb-1 text-xs font-medium uppercase tracking-wide text-text-muted">{t("Filtro")}</h2>
      {item(
        "condicoes",
        VISUAL_DAS_CONDICOES,
        t("Condições"),
        temCondicoes ? t("As condições ficam numa caixa só, e ela já está no desenho.") : null,
      )}
      <h2 className="px-1 pb-1 pt-3 text-xs font-medium uppercase tracking-wide text-text-muted">{t("Ações")}</h2>
      {ACOES_DA_PALETA.map((tipo) =>
        item(
          tipo,
          VISUAL_DA_ACAO[tipo],
          t(ACTION_LABELS[tipo]),
          acoesQueFechamLaco(evento, [{ type: tipo }]).length > 0 ? t(MENSAGEM_DO_LACO_DE_LEAD) : null,
        ),
      )}
      <p className="px-1 pt-3 text-xs text-text-muted">
        {t("Clique para pôr logo depois da caixa selecionada. Arraste para soltar onde quiser e ligar à mão.")}
      </p>
    </aside>
  );
}
