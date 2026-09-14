"use client";
/**
 * Os lançamentos do período — o dinheiro que não veio de comanda.
 *
 * Até a rota existir, `financial_entries` só nascia da finalização de comanda, e
 * o cartão "Saiu" do relatório logo acima era zero para sempre: não havia como
 * registrar aluguel, material ou salário. Metade do financeiro existia.
 *
 * ⚠️ O BOTÃO DE APAGAR SÓ APARECE EM LANÇAMENTO PENDENTE E MANUAL, e isso
 * espelha a rota de propósito. Pago é história, e o que veio de comanda pertence
 * à comanda — mostrar o botão e deixar a recusa para o servidor ensinaria a
 * pessoa a tentar o que nunca vai funcionar.
 */
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { formatCents, parseReaisToCents } from "@/lib/money";

export type Lancamento = {
  id: string;
  direction: "in" | "out";
  amount_cents: number;
  description: string | null;
  entry_date: string;
  status: "pending" | "paid";
  origin: string;
};

export type Conta = { id: string; name: string };

const hoje = () => new Date().toISOString().slice(0, 10);

export function ListaDeLancamentos({
  lancamentos,
  contas,
  podeLancar,
  onCriar,
  onPagar,
  onRemover,
}: {
  lancamentos: Lancamento[];
  contas: Conta[];
  podeLancar: boolean;
  onCriar: (corpo: Record<string, unknown>) => void;
  onPagar: (id: string) => void;
  onRemover: (id: string) => void;
}) {
  const t = useT();
  const [descricao, setDescricao] = useState("");
  const [valor, setValor] = useState("");
  const [direcao, setDirecao] = useState<"in" | "out">("out");
  const [contaId, setContaId] = useState("");
  const [data, setData] = useState(hoje);
  const [jaPago, setJaPago] = useState(true);

  // Reais digitados viram centavos aqui. `parseReaisToCents` devolve null no que
  // não é dinheiro, e o botão fica desabilitado — em vez de mandar NaN para uma
  // rota que escreve no extrato.
  const cents = parseReaisToCents(valor);
  const pode = podeLancar && descricao.trim().length > 0 && cents !== null && contaId !== "";

  return (
    <section className="rounded-md border border-border p-3">
      <h2 className="mb-2 text-sm font-semibold">{t("Lançamentos do período")}</h2>

      {podeLancar ? (
        <form
          className="mb-3 flex flex-wrap items-end gap-2 border-b border-border pb-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!pode) return;
            onCriar({
              account_id: contaId,
              direction: direcao,
              amount_cents: cents,
              description: descricao.trim(),
              entry_date: data,
              status: jaPago ? "paid" : "pending",
            });
            setDescricao("");
            setValor("");
          }}
        >
          <label className="flex flex-col gap-1 text-xs text-text-muted">
            {t("Tipo")}
            <select
              value={direcao}
              data-testid="lancamento-direcao"
              onChange={(e) => setDirecao(e.target.value as "in" | "out")}
              className="rounded-md border border-border bg-surface-elevated p-2 text-sm text-text"
            >
              <option value="out">{t("Saída")}</option>
              <option value="in">{t("Entrada")}</option>
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs text-text-muted">
            {t("Conta")}
            <select
              value={contaId}
              data-testid="lancamento-conta"
              onChange={(e) => setContaId(e.target.value)}
              className="rounded-md border border-border bg-surface-elevated p-2 text-sm text-text"
            >
              <option value="">{t("Escolha")}</option>
              {contas.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs text-text-muted">
            {t("Descrição")}
            <input
              value={descricao}
              data-testid="lancamento-descricao"
              onChange={(e) => setDescricao(e.target.value)}
              className="rounded-md border border-border bg-surface-elevated p-2 text-sm text-text"
            />
          </label>

          <label className="flex flex-col gap-1 text-xs text-text-muted">
            {t("Valor")}
            <input
              value={valor}
              inputMode="decimal"
              placeholder="0,00"
              data-testid="lancamento-valor"
              onChange={(e) => setValor(e.target.value)}
              className="w-28 rounded-md border border-border bg-surface-elevated p-2 text-sm text-text"
            />
          </label>

          <label className="flex flex-col gap-1 text-xs text-text-muted">
            {t("Data")}
            <input
              type="date"
              value={data}
              data-testid="lancamento-data"
              onChange={(e) => setData(e.target.value)}
              className="rounded-md border border-border bg-surface-elevated p-2 text-sm text-text"
            />
          </label>

          <label className="flex items-center gap-2 text-xs text-text-muted">
            <input
              type="checkbox"
              checked={jaPago}
              data-testid="lancamento-ja-pago"
              onChange={(e) => setJaPago(e.target.checked)}
              className="size-4 rounded-sm border-border accent-accent"
            />
            {t("Já pago")}
          </label>

          <Button type="submit" disabled={!pode} data-testid="incluir-lancamento">
            {t("Lançar")}
          </Button>
        </form>
      ) : null}

      {lancamentos.length === 0 ? (
        <p className="text-sm text-text-muted">{t("Nenhum lançamento no período.")}</p>
      ) : (
        <table className="w-full text-sm">
          <tbody>
            {lancamentos.map((l) => (
              <tr key={l.id} className="border-b border-border/60">
                <td className="py-1 text-text-muted">{l.entry_date}</td>
                <td className="py-1">
                  {l.description ?? "—"}
                  {l.origin !== "manual" ? (
                    <span className="ml-2 text-xs text-text-muted">{t("de comanda")}</span>
                  ) : null}
                </td>
                <td className="py-1 text-right tabular-nums">
                  {l.direction === "out" ? "-" : "+"}
                  {formatCents(l.amount_cents, "BRL")}
                </td>
                <td className="py-1 text-right text-xs text-text-muted">
                  {l.status === "paid" ? t("pago") : t("pendente")}
                </td>
                <td className="w-24 py-1 text-right">
                  {podeLancar && l.status === "pending" ? (
                    <>
                      <button
                        type="button"
                        onClick={() => onPagar(l.id)}
                        className="text-xs text-accent"
                        data-testid={`pagar-${l.id}`}
                      >
                        {t("Pagar")}
                      </button>
                      {l.origin === "manual" ? (
                        <button
                          type="button"
                          aria-label={t("Remover lançamento")}
                          onClick={() => onRemover(l.id)}
                          className="ml-2 text-text-muted hover:text-text"
                        >
                          ×
                        </button>
                      ) : null}
                    </>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
