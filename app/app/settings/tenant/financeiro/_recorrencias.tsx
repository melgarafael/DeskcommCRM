"use client";
/**
 * OS LANÇAMENTOS QUE SE REPETEM.
 *
 * Aluguel, internet, contador. Sem isto a saída era lançar à mão todo mês — a
 * que se esquece em fevereiro e faz o relatório do mês parecer melhor do que foi.
 *
 * ⚠️ A TELA DIZ QUE NASCE PENDENTE, e não é detalhe de implementação: quem
 * cadastra um aluguel precisa saber que o sistema vai abrir a conta a pagar, não
 * dar a conta por paga. Sem essa frase, o saldo do mês pareceria errado e a
 * pessoa desconfiaria do número, que é pior do que desconfiar da frase.
 */
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { formatCents, parseReaisToCents } from "@/lib/money";

export type Recorrencia = {
  id: string;
  name: string;
  account_id: string;
  direction: "in" | "out";
  amount_cents: number;
  /** A moeda da própria linha: o valor é escrito nela, nunca numa moeda fixa (#1531). */
  currency: string;
  day_of_month: number;
};

export type ContaDoCatalogo = { id: string; name: string };

export function Recorrencias({
  recorrencias,
  contas,
  podeEditar,
  carregando,
  onCriar,
  onEditar,
  onInativar,
}: {
  recorrencias: Recorrencia[];
  contas: ContaDoCatalogo[];
  podeEditar: boolean;
  carregando: boolean;
  onCriar: (corpo: Record<string, unknown>) => void;
  /** #2641: editar sem desativar-e-recriar — o corpo é o mesmo da criação. */
  onEditar: (id: string, corpo: Record<string, unknown>, aoSalvar: () => void) => void;
  onInativar: (id: string) => void;
}) {
  const t = useT();
  const [nome, setNome] = useState("");
  const [valor, setValor] = useState("");
  const [dia, setDia] = useState("5");
  const [direcao, setDirecao] = useState<"in" | "out">("out");
  const [contaId, setContaId] = useState("");
  const [editandoId, setEditandoId] = useState<string | null>(null);

  const limpar = () => {
    setNome("");
    setValor("");
    setDia("5");
    setDirecao("out");
    setContaId("");
    setEditandoId(null);
  };

  const cents = parseReaisToCents(valor);
  const diaNumero = Number(dia);
  const diaValido = Number.isInteger(diaNumero) && diaNumero >= 1 && diaNumero <= 31;
  const pode = nome.trim().length >= 2 && cents !== null && cents > 0 && diaValido && contaId !== "";

  return (
    <section className="space-y-3 rounded-xl border p-4">
      <h2 className="font-semibold">{t("Todo mês")}</h2>
      <p className="text-sm text-text-muted">
        {t("Aluguel, internet, contador. O sistema abre a conta no dia certo.")}
      </p>
      <p className="text-xs text-text-muted">
        {t(
          "Nasce como conta a pagar, nunca como paga: o sistema sabe que vence, não sabe se você pagou.",
        )}
      </p>

      {podeEditar ? (
        <div className="flex flex-wrap items-end gap-2">
          <input
            aria-label={t("Nome do lançamento")}
            className="min-h-11 rounded-md border p-2"
            placeholder={t("Ex.: Aluguel")}
            value={nome}
            onChange={(e) => setNome(e.target.value)}
          />

          <select
            aria-label={t("Entrada ou saída")}
            className="min-h-11 rounded-md border p-2"
            value={direcao}
            onChange={(e) => setDirecao(e.target.value as "in" | "out")}
          >
            <option value="out">{t("Saída")}</option>
            <option value="in">{t("Entrada")}</option>
          </select>

          <select
            aria-label={t("Conta")}
            className="min-h-11 rounded-md border p-2"
            value={contaId}
            onChange={(e) => setContaId(e.target.value)}
          >
            <option value="">{t("Escolha a conta")}</option>
            {contas.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>

          <input
            aria-label={t("Valor")}
            className="min-h-11 w-28 rounded-md border p-2"
            placeholder="0,00"
            inputMode="decimal"
            value={valor}
            onChange={(e) => setValor(e.target.value)}
          />

          <label className="flex flex-col gap-1 text-xs text-text-muted">
            {t("Dia do mês")}
            <input
              className="min-h-11 w-20 rounded-md border p-2"
              inputMode="numeric"
              value={dia}
              onChange={(e) => setDia(e.target.value)}
            />
          </label>

          <Button
            className="min-h-11"
            disabled={!pode}
            onClick={() => {
              const corpo = {
                name: nome.trim(),
                account_id: contaId,
                direction: direcao,
                amount_cents: cents,
                day_of_month: diaNumero,
              };
              if (editandoId) onEditar(editandoId, corpo, limpar);
              else onCriar(corpo);
            }}
          >
            {editandoId ? t("Salvar") : t("Adicionar")}
          </Button>
          {editandoId ? (
            <Button variant="ghost" className="min-h-11" onClick={limpar}>
              {t("Cancelar")}
            </Button>
          ) : null}

          {/*
            O aviso do dia 31 aparece só quando alguém escolhe um dia que não
            existe em todo mês. Dizer isso sempre seria ruído; dizer na hora
            evita a dúvida de "vai pular fevereiro?".
          */}
          {diaValido && diaNumero > 28 ? (
            <p className="w-full text-xs text-text-muted">
              {t("Nos meses mais curtos, cai no último dia do mês.")}
            </p>
          ) : null}
        </div>
      ) : null}

      {carregando ? (
        <p className="text-sm text-text-muted">{t("Carregando...")}</p>
      ) : recorrencias.length === 0 ? (
        <p className="text-sm text-text-muted">{t("Nenhum lançamento recorrente.")}</p>
      ) : (
        <ul className="space-y-1">
          {recorrencias.map((r) => (
            <li
              key={r.id}
              className="flex items-center justify-between rounded-md border border-border p-2 text-sm"
            >
              <span>
                {r.name} · {r.direction === "out" ? t("Saída") : t("Entrada")} ·{" "}
                {formatCents(r.amount_cents, r.currency)} · {t("dia")} {r.day_of_month}
              </span>
              {podeEditar ? (
                <span className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    className="min-h-11"
                    onClick={() => {
                      // Preenche o MESMO formulário da criação com o
                      // lançamento escolhido; o Salvar manda o PATCH (#2641).
                      setNome(r.name);
                      setDirecao(r.direction);
                      setContaId(r.account_id);
                      setValor((r.amount_cents / 100).toFixed(2).replace(".", ","));
                      setDia(String(r.day_of_month));
                      setEditandoId(r.id);
                    }}
                  >
                    {t("Editar")}
                  </Button>
                  <button
                    type="button"
                    aria-label={t("Remover lançamento recorrente")}
                    onClick={() => onInativar(r.id)}
                    className="text-text-muted hover:text-text"
                  >
                    ×
                  </button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
