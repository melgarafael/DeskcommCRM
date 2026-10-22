"use client";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useT } from "@/hooks/i18n/useT";
import { Plus } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

import { useAcoesDoMapa } from "../AcoesDoMapa";

/**
 * O "+" do ManyChat: clicar na saída de um bloco oferece a lista de blocos, e o
 * escolhido nasce ao lado JÁ LIGADO àquela saída — sem arrastar seta nenhuma.
 *
 * `nodrag nopan` são as classes que o React Flow respeita para o clique não
 * virar arrasto do cartão nem do mapa; o `stopPropagation` impede que o clique
 * também selecione o cartão (o painel abriria por baixo do menu).
 */
export function BotaoProximoBloco({
  nodeId,
  ramo,
  rotulo,
  className,
}: {
  nodeId: string;
  /** Id do ramo; `null` = a única saída do bloco. */
  ramo: string | null;
  /** Para o leitor de tela: de qual saída sai o bloco novo. */
  rotulo: string;
  className?: string;
}) {
  const t = useT();
  const acoes = useAcoesDoMapa();
  if (!acoes) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "nodrag nopan flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-border bg-surface text-text-muted hover:border-accent-500 hover:text-accent-500",
            className,
          )}
          aria-label={`${t("Adicionar o próximo bloco em")} ${rotulo}`}
          data-testid={`proximo-bloco-${nodeId}-${ramo ?? "unica"}`}
          onClick={(e) => e.stopPropagation()}
        >
          <Plus size={10} aria-hidden />
        </button>
      </DropdownMenuTrigger>
      {/* O menu mora num portal, mas evento do React atravessa portal: sem
          parar aqui, o clique no item chegava ao cartão de ORIGEM e o
          selecionava por cima do bloco recém-criado (medido no teste). */}
      <DropdownMenuContent
        align="start"
        className="max-h-80 overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <DropdownMenuLabel>{t("Próximo bloco")}</DropdownMenuLabel>
        {acoes.tipos
          .filter((v) => v.type !== "trigger")
          .map((visual) => {
            const Icon = visual.icon;
            return (
              <DropdownMenuItem
                key={visual.type}
                onSelect={() => acoes.adicionarDepois(nodeId, ramo, visual.type)}
                data-testid={`proximo-bloco-opcao-${visual.type}`}
              >
                <span className={cn("flex h-5 w-5 items-center justify-center rounded-full", visual.chipClassName)}>
                  <Icon size={12} aria-hidden />
                </span>
                {t(visual.paletteLabel)}
              </DropdownMenuItem>
            );
          })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
