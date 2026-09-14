"use client";
/**
 * O faturamento na tela.
 *
 * ⚠️ NENHUM NÚMERO É CALCULADO AQUI. Todos vêm prontos de
 * `fn_relatorio_financeiro`, e isso é o desenho: somar na tela o que a API
 * devolve paginado é como um relatório passa a mentir sem ninguém perceber. Esta
 * tela formata e dispõe; ela não faz conta.
 *
 * A única exceção é a porcentagem de cada forma de pagamento sobre o faturado, e
 * ela é uma razão entre dois números que já vieram somados — não uma segunda
 * apuração dos mesmos dados.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { formatCents } from "@/lib/money";

import { ListaDeLancamentos, type Conta, type Lancamento } from "./_lancamentos";

type Forma = { nome: string; quantidade: number; total_cents: number };
type Profissional = { attendant_user_id: string | null; itens: number; comissao_cents: number };

type Relatorio = {
  de: string;
  ate: string;
  entradas_cents: number;
  saidas_cents: number;
  saldo_cents: number;
  comandas_finalizadas: number;
  comandas_estornadas: number;
  faturado_cents: number;
  ticket_medio_cents: number;
  por_forma: Forma[];
  por_profissional: Profissional[];
};

type Pessoa = { user_id: string; name: string | null; email: string | null };

const hoje = () => new Date().toISOString().slice(0, 10);
const primeiroDoMes = () => `${hoje().slice(0, 7)}-01`;

export function Faturamento({ podeLancar }: { podeLancar: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const [de, setDe] = useState(primeiroDoMes);
  const [ate, setAte] = useState(hoje);

  const relatorio = useQuery({
    queryKey: ["relatorio", "financeiro", de, ate],
    queryFn: async () =>
      (
        await apiClient.get<{ data: Relatorio }>(
          `/api/v1/reports/financeiro?de=${de}&ate=${ate}`,
        )
      ).data,
  });

  // Os nomes de quem atendeu não vêm do relatório: ele devolve o id, e juntar
  // aqui evita que a função no banco precise conhecer a tabela de equipe.
  const equipe = useQuery({
    queryKey: ["team", "assignable"],
    queryFn: async () => (await apiClient.get<{ data: Pessoa[] }>("/api/v1/team/assignable")).data,
  });

  const nomeDe = (id: string | null) => {
    if (!id) return t("Sem responsável");
    const p = (equipe.data ?? []).find((x) => x.user_id === id);
    return p?.name ?? p?.email ?? t("Sem responsável");
  };

  const lancamentos = useQuery({
    queryKey: ["lancamentos", de, ate],
    queryFn: async () =>
      (
        await apiClient.get<{ data: Lancamento[] }>(
          `/api/v1/financeiro/lancamentos?de=${de}&ate=${ate}`,
        )
      ).data,
  });

  const contas = useQuery({
    queryKey: ["financeiro", "catalogo", "contas"],
    queryFn: async () =>
      (await apiClient.get<{ data: Conta[] }>("/api/v1/financeiro/catalogo/contas")).data,
  });

  // O RELATÓRIO ENTRA NA INVALIDAÇÃO junto com a lista, e não só ela: lançar uma
  // saída muda o saldo do período, e deixar o cartão com o número velho seria a
  // tela se contradizendo a três centímetros de distância.
  const recarregar = () => {
    void qc.invalidateQueries({ queryKey: ["lancamentos"] });
    void qc.invalidateQueries({ queryKey: ["relatorio", "financeiro"] });
  };

  const criar = useMutation({
    mutationFn: (corpo: Record<string, unknown>) =>
      apiClient.post("/api/v1/financeiro/lancamentos", corpo),
    onSuccess: recarregar,
    onError: showApiError,
  });

  const pagar = useMutation({
    mutationFn: (id: string) =>
      apiClient.patch(`/api/v1/financeiro/lancamentos/${id}`, { pay: true }),
    onSuccess: recarregar,
    onError: showApiError,
  });

  const remover = useMutation({
    mutationFn: (id: string) => apiClient.delete(`/api/v1/financeiro/lancamentos/${id}`),
    onSuccess: recarregar,
    onError: showApiError,
  });

  const r = relatorio.data;

  return (
    <div className="flex flex-col gap-4">
      <form className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-text-muted">
          {t("De")}
          <input
            type="date"
            value={de}
            data-testid="periodo-de"
            onChange={(e) => setDe(e.target.value)}
            className="rounded-md border border-border bg-surface-elevated p-2 text-sm text-text"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-text-muted">
          {t("Até")}
          <input
            type="date"
            value={ate}
            data-testid="periodo-ate"
            onChange={(e) => setAte(e.target.value)}
            className="rounded-md border border-border bg-surface-elevated p-2 text-sm text-text"
          />
        </label>
      </form>

      {relatorio.isError ? (
        <p className="text-sm text-danger">{t("Não foi possível carregar o período.")}</p>
      ) : null}

      {r ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Cartao titulo={t("Entrou")} valor={formatCents(r.entradas_cents, "BRL")} destaque />
            <Cartao titulo={t("Saiu")} valor={formatCents(r.saidas_cents, "BRL")} />
            <Cartao titulo={t("Saldo")} valor={formatCents(r.saldo_cents, "BRL")} destaque />
            <Cartao
              titulo={t("Ticket médio")}
              valor={formatCents(r.ticket_medio_cents, "BRL")}
            />
          </div>

          <p className="text-sm text-text-muted" data-testid="resumo-de-comandas">
            {r.comandas_finalizadas} {t("comanda(s) finalizada(s)")}
            {r.comandas_estornadas > 0
              ? `, ${r.comandas_estornadas} ${t("estornada(s)")}`
              : ""}
            {" · "}
            {formatCents(r.faturado_cents, "BRL")} {t("faturado")}
          </p>

          {/*
            ⚠️ O FATURADO E O QUE ENTROU PODEM DIFERIR, e isso não é defeito: uma
            comanda fechada hoje pode ter lançamento com data de amanhã, e um
            lançamento manual (aluguel, material) não veio de comanda nenhuma.
            Comparar os dois é erro de leitura, e o aviso existe para que ninguém
            passe a tarde procurando a diferença.
          */}
          <p className="text-xs text-text-muted">
            {t(
              "O faturado soma comandas; o que entrou soma lançamentos pagos. Os dois não precisam bater.",
            )}
          </p>

          <Tabela titulo={t("Por forma de pagamento")} vazio={t("Nenhuma comanda no período.")}>
            {r.por_forma.map((f) => (
              <tr key={f.nome} className="border-b border-border/60">
                <td className="py-1">{f.nome}</td>
                <td className="py-1 text-right text-text-muted">{f.quantidade}</td>
                <td className="py-1 text-right tabular-nums">
                  {formatCents(f.total_cents, "BRL")}
                </td>
                <td className="py-1 text-right text-text-muted">
                  {r.faturado_cents > 0
                    ? `${Math.round((f.total_cents / r.faturado_cents) * 100)}%`
                    : "—"}
                </td>
              </tr>
            ))}
          </Tabela>

          <Tabela titulo={t("Comissão por pessoa")} vazio={t("Nenhuma comissão no período.")}>
            {r.por_profissional.map((p) => (
              <tr key={p.attendant_user_id ?? "sem"} className="border-b border-border/60">
                <td className="py-1">{nomeDe(p.attendant_user_id)}</td>
                <td className="py-1 text-right text-text-muted">{p.itens}</td>
                <td className="py-1 text-right tabular-nums" colSpan={2}>
                  {formatCents(p.comissao_cents, "BRL")}
                </td>
              </tr>
            ))}
          </Tabela>
        </>
      ) : null}

      <ListaDeLancamentos
        lancamentos={lancamentos.data ?? []}
        contas={contas.data ?? []}
        podeLancar={podeLancar}
        onCriar={(corpo) => criar.mutate(corpo)}
        onPagar={(id) => pagar.mutate(id)}
        onRemover={(id) => remover.mutate(id)}
      />
    </div>
  );
}

function Cartao({
  titulo,
  valor,
  destaque,
}: {
  titulo: string;
  valor: string;
  destaque?: boolean;
}) {
  return (
    <div className="rounded-md border border-border p-3">
      <p className="text-xs text-text-muted">{titulo}</p>
      <p className={`tabular-nums ${destaque ? "text-xl font-semibold" : "text-lg"}`}>{valor}</p>
    </div>
  );
}

function Tabela({
  titulo,
  vazio,
  children,
}: {
  titulo: string;
  vazio: string;
  children: React.ReactNode;
}) {
  const temLinha = Array.isArray(children) ? children.length > 0 : Boolean(children);
  return (
    <section className="rounded-md border border-border p-3">
      <h2 className="mb-2 text-sm font-semibold">{titulo}</h2>
      {temLinha ? (
        <table className="w-full text-sm">
          <tbody>{children}</tbody>
        </table>
      ) : (
        <p className="text-sm text-text-muted">{vazio}</p>
      )}
    </section>
  );
}
