"use client";

/**
 * O bloco "Vendas" de um negócio — o MESMO no negócio aberto pelo
 * funil e no painel do Inbox.
 *
 * Uma porta só para "quanto vendeu": em cima, o botão "Registrar venda", que
 * abre valor, data, tags e observação; embaixo, todas as vendas já registradas,
 * com a data ao lado e a lixeira (com confirmação). O Valor do negócio, que o
 * card mostra, é a soma delas, gravada pelo gatilho do banco.
 *
 * Antes havia também o campo Valor com "Salvar": ele gravava o valor do negócio
 * e NÃO entrava em Vendas — quem digitava 180 via o número ficar parado na
 * caixa e a venda não aparecer em lugar nenhum. Esse caminho saiu.
 *
 * Apagar fica para quem registrou ou para gestor — a rota confere; a tela só
 * oferece a lixeira e mostra o motivo se a rota recusar.
 */
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { useApagarVenda, useVendasDoNegocio } from "@/hooks/vendas/useVendasRegistradas";
import { formatCents } from "@/lib/money";
import { Plus, Trash } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

import { RegistrarVendaDialog } from "./RegistrarVendaDialog";

interface Props {
  leadId: string;
  titulo?: string | null;
  moeda?: string;
  /** Sem permissão de escrita (leitor, funil arquivado): só a lista, sem botão nem lixeira. */
  somenteLeitura?: boolean;
  /** Depois de registrar ou apagar — para quem mostra o negócio fora do TanStack Query (o Inbox). */
  aoMudar?: () => void;
  /** Coluna estreita do Inbox: textos e botão menores. */
  compacto?: boolean;
}

export function VendasDoNegocio({
  leadId,
  titulo,
  moeda = "BRL",
  somenteLeitura = false,
  aoMudar,
  compacto = false,
}: Props) {
  const t = useT();
  const tagDeIdioma = useTagDeIdioma();
  const { data: vendas, isLoading, isError } = useVendasDoNegocio(leadId);
  const apagar = useApagarVenda();
  const [aberto, setAberto] = useState(false);

  const lista = Array.isArray(vendas) ? vendas : [];
  const dia = new Intl.DateTimeFormat(tagDeIdioma, { dateStyle: "short", timeZone: "UTC" });
  const total = lista.reduce((soma, v) => soma + (v.currency === moeda ? v.valor_cents : 0), 0);
  const texto = compacto ? "text-xs" : "text-sm";

  return (
    <div className="flex flex-col gap-2" data-testid="vendas-do-negocio">
      {!somenteLeitura && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className={cn("w-full", compacto && "h-8 text-xs")}
          onClick={() => setAberto(true)}
          data-testid="abrir-registrar-venda"
        >
          <Plus className="mr-1 size-4" />
          {t("Registrar venda")}
        </Button>
      )}

      {isLoading ? (
        <p className={cn(texto, "text-text-muted")}>{t("Carregando…")}</p>
      ) : isError ? (
        <p className={cn(texto, "text-danger")}>{t("Não foi possível carregar as vendas.")}</p>
      ) : lista.length === 0 ? (
        <p className={cn(texto, "text-text-muted")}>{t("Nenhuma venda registrada neste negócio.")}</p>
      ) : (
        <>
          <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
            {lista.map((v) => (
              <li key={v.id} className={cn("flex items-start justify-between gap-2 p-2", texto)} data-testid="venda-registrada">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="font-medium tabular-nums">{formatCents(v.valor_cents, v.currency)}</span>
                    <span className="text-xs text-text-muted">{dia.format(new Date(`${v.data}T00:00:00Z`))}</span>
                  </div>
                  {v.tags.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {v.tags.map((tag) => (
                        <span key={tag} className="rounded-full bg-surface-elevated px-2 py-0.5 text-xs">
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                  {v.observacao && <p className="mt-1 text-xs text-text-muted">{v.observacao}</p>}
                </div>
                {!somenteLeitura && (
                  <button
                    type="button"
                    title={t("Apagar venda")}
                    aria-label={t("Apagar venda")}
                    disabled={apagar.isPending}
                    onClick={() => {
                      if (window.confirm(t("Apagar esta venda? Ela sai do painel de vendas.")))
                        apagar.mutate(v.id, { onSuccess: () => aoMudar?.() });
                    }}
                    className="shrink-0 rounded-md p-1 text-text-muted hover:bg-surface-elevated hover:text-danger"
                  >
                    <Trash className="size-4" />
                  </button>
                )}
              </li>
            ))}
          </ul>
          <p className="text-xs text-text-muted" data-testid="total-das-vendas">
            {lista.length} {t("venda(s)")} · {t("total")} {formatCents(total, moeda)}
          </p>
        </>
      )}

      {aberto && (
        <RegistrarVendaDialog
          open
          onOpenChange={setAberto}
          leadId={leadId}
          titulo={titulo}
          moeda={moeda}
          aoRegistrar={aoMudar}
        />
      )}
    </div>
  );
}
