"use client";

/**
 * O "+" de venda no card do funil.
 *
 * Um botão pequeno ao lado do menu do card que abre "Registrar venda" sem abrir
 * o negócio. Guarda o próprio estado — o card é `memo` e arrastável, e um
 * estado a mais nele faria cada abertura re-renderizar a coluna. O clique NÃO
 * sobe para o card (que abriria o negócio) nem inicia arraste.
 */
import { useState, type MouseEvent } from "react";

import { useT } from "@/hooks/i18n/useT";
import { Plus } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

import { RegistrarVendaDialog } from "./RegistrarVendaDialog";

interface Props {
  leadId: string;
  titulo?: string | null;
  moeda?: string;
  className?: string;
}

export function BotaoRegistrarVenda({ leadId, titulo, moeda, className }: Props) {
  const t = useT();
  const [aberto, setAberto] = useState(false);
  const parar = (e: MouseEvent) => e.stopPropagation();

  return (
    <>
      <button
        type="button"
        data-testid="card-registrar-venda"
        title={t("Registrar venda")}
        aria-label={t("Registrar venda")}
        onMouseDown={parar}
        onClick={(e) => {
          e.stopPropagation();
          setAberto(true);
        }}
        className={cn(
          "shrink-0 rounded-md p-1 text-text-muted transition-colors hover:bg-surface-elevated hover:text-accent",
          className,
        )}
      >
        <Plus className="size-4" />
      </button>
      {aberto && (
        // O diálogo vive num portal; o `div` só segura a propagação do clique.
        <div onClick={parar} onMouseDown={parar}>
          <RegistrarVendaDialog open onOpenChange={setAberto} leadId={leadId} titulo={titulo} moeda={moeda} />
        </div>
      )}
    </>
  );
}
