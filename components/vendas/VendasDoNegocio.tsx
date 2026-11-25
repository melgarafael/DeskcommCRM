"use client";

/**
 * A seção "Vendas" de um negócio — no negócio aberto pelo funil e
 * no painel do Inbox.
 *
 * Mostra cada venda registrada (data, valor, tags, observação), o total, e o
 * botão "+ Registrar venda". Apagar fica para quem registrou ou para gestor — a
 * rota confere; a tela só oferece a lixeira e mostra o motivo se a rota recusar.
 */
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { useApagarVenda, useVendasDoNegocio } from "@/hooks/vendas/useVendasRegistradas";
import { formatCents } from "@/lib/money";
import { Plus, Trash } from "@/lib/ui/icons";

import { RegistrarVendaDialog } from "./RegistrarVendaDialog";

interface Props {
  leadId: string;
  titulo?: string | null;
  moeda?: string;
  /** Sem permissão de escrita (leitor, funil arquivado): só a lista. */
  somenteLeitura?: boolean;
  /**
   * O botão de registrar mora no campo Valor (o "+" ao lado dele): aqui fica só
   * o histórico, para não haver dois lugares para a mesma coisa.
   */
  semRegistrar?: boolean;
  /** Depois de apagar — para quem mostra o valor fora do TanStack Query (o Inbox). */
  aoMudar?: () => void;
}

export function VendasDoNegocio({
  leadId,
  titulo,
  moeda = "BRL",
  somenteLeitura = false,
  semRegistrar = false,
  aoMudar,
}: Props) {
  const t = useT();
  const tagDeIdioma = useTagDeIdioma();
  const { data: vendas, isLoading, isError } = useVendasDoNegocio(leadId);
  const apagar = useApagarVenda();
  const [aberto, setAberto] = useState(false);

  const dia = new Intl.DateTimeFormat(tagDeIdioma, { dateStyle: "short", timeZone: "UTC" });
  const total = (vendas ?? []).reduce((soma, v) => soma + (v.currency === moeda ? v.valor_cents : 0), 0);

  return (
    <div className="flex flex-col gap-2" data-testid="vendas-do-negocio">
      {isLoading ? (
        <p className="text-sm text-text-muted">{t("Carregando…")}</p>
      ) : isError ? (
        <p className="text-sm text-danger">{t("Não foi possível carregar as vendas.")}</p>
      ) : (vendas ?? []).length === 0 ? (
        <p className="text-sm text-text-muted">
          {semRegistrar && !somenteLeitura
            ? t("Nenhuma venda ainda. Use o + ao lado do Valor para registrar.")
            : t("Nenhuma venda registrada neste negócio.")}
        </p>
      ) : (
        <>
          <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
            {(vendas ?? []).map((v) => (
              <li key={v.id} className="flex items-start justify-between gap-2 p-2 text-sm" data-testid="venda-registrada">
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
                      if (window.confirm(t("Apagar esta venda? Ela sai do painel de vendas."))) apagar.mutate(v.id, { onSuccess: () => aoMudar?.() });
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
            {(vendas ?? []).length} {t("venda(s)")} · {t("total")} {formatCents(total, moeda)}
          </p>
        </>
      )}

      {!somenteLeitura && !semRegistrar && (
        <Button size="sm" variant="outline" onClick={() => setAberto(true)} data-testid="abrir-registrar-venda">
          <Plus className="mr-1 size-4" />
          {t("Registrar venda")}
        </Button>
      )}

      {aberto && (
        <RegistrarVendaDialog open onOpenChange={setAberto} leadId={leadId} titulo={titulo} moeda={moeda} />
      )}
    </div>
  );
}
