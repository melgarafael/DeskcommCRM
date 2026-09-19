"use client";
/**
 * ATENDIMENTOS QUE ACONTECERAM E FICARAM SEM COMANDA.
 *
 * No sistema de origem, um agente externo disparava isto às 20h — e a medição
 * mostrou que era a única das 22 capacidades dele realmente viva. Aqui ela é uma
 * lista que alguém confere e fatura, que é o que ela sempre deveria ter sido.
 *
 * ⚠️ NADA VEM MARCADO. Faturar é irreversível (o desfazer é estorno, um por um),
 * e uma lista pré-marcada transforma "conferir" em "clicar em faturar". Quem
 * confere marca.
 *
 * ⚠️ O ATENDIMENTO SEM PREÇO APARECE, mas não pode ser marcado. Escondê-lo faria
 * o atendimento sumir das duas telas — não estaria aqui nem viraria comanda —, e
 * ninguém descobriria que ele existe. Aparecendo com o aviso, a pessoa sabe que
 * precisa abrir a comanda à mão ou pôr preço no serviço.
 */
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { formatCents } from "@/lib/money";

export type Pendente = {
  appointment_id: string;
  title: string;
  starts_at: string;
  contact_id: string | null;
  service_name: string | null;
  suggested_price_cents: number | null;
};

export type FormaDePagamento = { id: string; name: string; account_id: string | null };

export function AtendimentosSemComanda({
  pendentes,
  formas,
  podeLancar,
  pendenteDeEnvio,
  onFaturar,
}: {
  pendentes: Pendente[];
  formas: FormaDePagamento[];
  podeLancar: boolean;
  pendenteDeEnvio: boolean;
  onFaturar: (corpo: { appointment_ids: string[]; payment_method_id: string }) => void;
}) {
  const t = useT();
  const [marcados, setMarcados] = useState<Set<string>>(new Set());
  const [formaId, setFormaId] = useState("");

  if (pendentes.length === 0) return null;

  const alternar = (id: string) => {
    setMarcados((atual) => {
      const novo = new Set(atual);
      if (novo.has(id)) novo.delete(id);
      else novo.add(id);
      return novo;
    });
  };

  const faturaveis = pendentes.filter((p) => p.suggested_price_cents !== null);
  const total = pendentes
    .filter((p) => marcados.has(p.appointment_id))
    .reduce((acc, p) => acc + (p.suggested_price_cents ?? 0), 0);

  const escolhida = formas.find((f) => f.id === formaId);

  return (
    <section className="rounded-md border border-border p-3">
      <h2 className="mb-1 text-sm font-semibold">{t("Atendimentos sem comanda")}</h2>
      <p className="mb-2 text-xs text-text-muted">
        {t("Já aconteceram e ninguém faturou. Marque o que quer cobrar.")}
      </p>

      <ul className="mb-3 space-y-1">
        {pendentes.map((p) => {
          const semPreco = p.suggested_price_cents === null;
          return (
            <li key={p.appointment_id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={marcados.has(p.appointment_id)}
                disabled={semPreco || !podeLancar}
                onChange={() => alternar(p.appointment_id)}
                data-testid={`pendente-${p.appointment_id}`}
                className="size-4 rounded-sm border-border accent-accent disabled:opacity-40"
              />
              <span className="flex-1">
                {p.service_name ?? p.title}
                <span className="ml-2 text-xs text-text-muted">
                  {new Date(p.starts_at).toLocaleDateString()}
                </span>
              </span>
              <span className="tabular-nums">
                {semPreco ? (
                  <span className="text-xs text-danger">{t("sem preço no serviço")}</span>
                ) : (
                  formatCents(p.suggested_price_cents ?? 0, "BRL")
                )}
              </span>
            </li>
          );
        })}
      </ul>

      {podeLancar && faturaveis.length > 0 ? (
        <div className="flex flex-wrap items-end gap-2 border-t border-border pt-3">
          <select
            aria-label={t("Forma de pagamento")}
            value={formaId}
            data-testid="forma-do-lote"
            onChange={(e) => setFormaId(e.target.value)}
            className="rounded-md border border-border bg-surface-elevated p-2 text-sm text-text"
          >
            <option value="">{t("Forma de pagamento")}</option>
            {formas.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>

          <Button
            disabled={marcados.size === 0 || !formaId || pendenteDeEnvio}
            data-testid="faturar-lote"
            onClick={() =>
              onFaturar({
                appointment_ids: [...marcados],
                payment_method_id: formaId,
              })
            }
          >
            {t("Faturar")} {marcados.size > 0 ? `(${formatCents(total, "BRL")})` : ""}
          </Button>

          {/*
            O mesmo aviso do fechamento avulso, e pela mesma razão — só que aqui
            ele evita um erro multiplicado por trinta.
          */}
          {escolhida && !escolhida.account_id ? (
            <p className="w-full text-xs text-danger">
              {t(
                "Esta forma de pagamento ainda não tem conta de destino. Defina em Configurações › Financeiro.",
              )}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
