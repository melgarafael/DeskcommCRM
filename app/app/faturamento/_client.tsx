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
 *
 * ⚠️ MOEDAS DIFERENTES NÃO SE SOMAM (#1531). Com lançamentos ou comandas em mais
 * de uma moeda no período, cada moeda ganha o seu bloco — cartões, ticket
 * médio e listas —, com os números que o relatório já devolve separados em
 * `por_moeda`. A ordem dos blocos é a única decisão da tela, e ela não é uma
 * conta: a moeda da organização primeiro, as demais em ordem alfabética.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useState } from "react";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";
import { diaDeHojeLocal } from "@/lib/ai/pacing-knobs";
import { apiClient } from "@/lib/api/client";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import { formatCents } from "@/lib/money";

import { ListaDeLancamentos, type Conta, type Lancamento } from "./_lancamentos";

type Forma = { nome: string; quantidade: number; total_cents: number };
type Profissional = { attendant_user_id: string | null; itens: number; comissao_cents: number };
type Servico = { nome: string; quantidade: number; total_cents: number };
type Cliente = { contact_id: string; comandas: number; total_cents: number };

/** O que o relatório devolve no topo e, com as mesmas chaves, para cada moeda. */
type Totais = {
  entradas_cents: number;
  saidas_cents: number;
  saldo_cents: number;
  comandas_finalizadas: number;
  comandas_estornadas: number;
  faturado_cents: number;
  ticket_medio_cents: number;
  por_forma: Forma[];
  por_profissional: Profissional[];
  por_servico: Servico[];
  por_cliente: Cliente[];
};

type Relatorio = Totais & {
  de: string;
  ate: string;
  por_moeda?: Record<string, Totais>;
};

/** O formato de `/api/v1/team/assignable`: o nome vem em `full_name`. */
type Pessoa = { user_id: string; full_name: string | null };

/**
 * O período padrão do relatório no calendário de quem usa a tela (#2935).
 * `toISOString()` dava o dia UTC: depois das 21h em Brasília o "até" pulava para
 * amanhã e, no último dia do mês, o "dia 1º" saltava para o mês seguinte. O
 * `primeiroDoMes` é derivado do MESMO `hoje` local, então os dois andam juntos.
 */
export const hoje = () => diaDeHojeLocal();
export const primeiroDoMes = () => `${hoje().slice(0, 7)}-01`;

/**
 * Um bloco por moeda, na ordem de `formatSomaPorMoeda` (lib/money.ts): a moeda
 * da organização primeiro, as demais em ordem alfabética do código ISO —
 * determinística, para o bloco não trocar de lugar a cada recarga.
 *
 * Sem `por_moeda` (período vazio, ou o banco ainda sem a migration 0444), um
 * bloco só com os números do topo na moeda da organização. Numa organização em
 * real é a tela de antes; em outra moeda, não.
 *
 * ponytail: nenhuma rota grava `currency` em comanda, lançamento ou recorrência
 * — as linhas nascem 'BRL' pelo default da coluna, a mesma classe de defeito que
 * a 0400 corrigiu para os negócios nascidos da conversa. Até a escrita herdar `organizations.currency`,
 * uma organização em outra moeda vê o período com movimento em R$ e o vazio na
 * moeda dela (e, sem a 0444, os totais em BRL saem com o símbolo dela). Teto
 * conhecido; o upgrade é a escrita herdar a moeda, e este fallback fica certo.
 */
function blocosPorMoeda(r: Relatorio, moedaDaOrg: string): Array<[string, Totais]> {
  const blocos = Object.entries(r.por_moeda ?? {});
  if (blocos.length === 0) return [[moedaDaOrg, r]];
  return blocos.sort(([a], [b]) =>
    a === moedaDaOrg ? -1 : b === moedaDaOrg ? 1 : a.localeCompare(b),
  );
}

export function Faturamento({
  podeLancar,
  moedaDaOrg,
}: {
  podeLancar: boolean;
  moedaDaOrg: string;
}) {
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
    return p?.full_name ?? t("Sem responsável");
  };

  // Os nomes dos clientes, pelo mesmo motivo dos da equipe: o relatório devolve
  // id, e resolver aqui evita que a função no banco precise conhecer contatos.
  const contatos = useQuery({
    queryKey: ["contacts", "para-relatorio"],
    queryFn: async () =>
      (
        await apiClient.get<{ data: Array<{ id: string; display_name: string | null; name: string | null }> }>(
          "/api/v1/contacts?limit=100",
        )
      ).data,
  });

  const nomeDoContato = (id: string) =>
    rotuloDoContato(
      (contatos.data ?? []).find((x) => x.id === id),
      t,
    );

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
  const blocos = r ? blocosPorMoeda(r, moedaDaOrg) : [];
  const variasMoedas = blocos.length > 1;

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
            className="rounded-md border border-border bg-surface-elevated p-2 text-sm text-text max-md:min-h-11"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-text-muted">
          {t("Até")}
          <input
            type="date"
            value={ate}
            data-testid="periodo-ate"
            onChange={(e) => setAte(e.target.value)}
            className="rounded-md border border-border bg-surface-elevated p-2 text-sm text-text max-md:min-h-11"
          />
        </label>
      </form>

      {relatorio.isError ? (
        <p className="text-sm text-danger">{t("Não foi possível carregar o período.")}</p>
      ) : null}

      {variasMoedas ? (
        <p className="text-sm text-text-muted">
          {t("Moedas diferentes não se somam: cada uma tem o seu bloco.")}
        </p>
      ) : null}

      {/*
        Com UMA moeda o bloco entra sem moldura nem título: a tela fica
        exatamente como era. A moldura só aparece quando há o que separar.
      */}
      {blocos.map(([moeda, totais], i) => {
        const bloco = (
          <BlocoDaMoeda
            moeda={moeda}
            totais={totais}
            comAviso={i === 0}
            nomeDe={nomeDe}
            nomeDoContato={nomeDoContato}
          />
        );
        return variasMoedas ? (
          <section key={moeda} data-testid={`bloco-${moeda}`} className="flex flex-col gap-4">
            <h2 className="text-base font-semibold">{moeda}</h2>
            {bloco}
          </section>
        ) : (
          <Fragment key={moeda}>{bloco}</Fragment>
        );
      })}

      <ListaDeLancamentos
        lancamentos={lancamentos.data ?? []}
        contas={contas.data ?? []}
        // A moeda da organização é a régua do valor digitado (#3367) — mesma
        // moeda que ordena os blocos acima. A `currency` gravada na linha ainda
        // nasce no padrão do banco, BRL (ver #3379).
        moeda={moedaDaOrg}
        podeLancar={podeLancar}
        onCriar={(corpo) => criar.mutate(corpo)}
        onPagar={(id) => pagar.mutate(id)}
        onRemover={(id) => remover.mutate(id)}
      />
    </div>
  );
}

/**
 * Os números de UMA moeda: cartões, resumo e as quatro listas.
 *
 * ⚠️ Todo valor aqui é da moeda do bloco, inclusive a porcentagem de cada forma
 * de pagamento, que é sobre o faturado DESTA moeda. Dividir o real pelo
 * faturado das duas moedas juntas seria a soma entre moedas voltando por
 * outra porta.
 */
function BlocoDaMoeda({
  moeda,
  totais,
  comAviso,
  nomeDe,
  nomeDoContato,
}: {
  moeda: string;
  totais: Totais;
  comAviso: boolean;
  nomeDe: (id: string | null) => string;
  nomeDoContato: (id: string) => string;
}) {
  const t = useT();
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Cartao titulo={t("Entrou")} valor={formatCents(totais.entradas_cents, moeda)} destaque />
        <Cartao titulo={t("Saiu")} valor={formatCents(totais.saidas_cents, moeda)} />
        <Cartao titulo={t("Saldo")} valor={formatCents(totais.saldo_cents, moeda)} destaque />
        <Cartao titulo={t("Ticket médio")} valor={formatCents(totais.ticket_medio_cents, moeda)} />
      </div>

      <p className="text-sm text-text-muted" data-testid="resumo-de-comandas">
        {totais.comandas_finalizadas} {t("comanda(s) finalizada(s)")}
        {totais.comandas_estornadas > 0
          ? `, ${totais.comandas_estornadas} ${t("estornada(s)")}`
          : ""}
        {" · "}
        {formatCents(totais.faturado_cents, moeda)} {t("faturado")}
      </p>

      {/*
        ⚠️ O FATURADO E O QUE ENTROU PODEM DIFERIR, e isso não é defeito: uma
        comanda fechada hoje pode ter lançamento com data de amanhã, e um
        lançamento manual (aluguel, material) não veio de comanda nenhuma.
        Comparar os dois é erro de leitura, e o aviso existe para que ninguém
        passe a tarde procurando a diferença. Com várias moedas, ele entra só no
        primeiro bloco: repetido em cada um, viraria ruído que ninguém lê.
      */}
      {comAviso ? (
        <p className="text-xs text-text-muted">
          {t(
            "O faturado soma comandas; o que entrou soma lançamentos pagos. Os dois não precisam bater.",
          )}
        </p>
      ) : null}

      <Tabela titulo={t("Por forma de pagamento")} vazio={t("Nenhuma comanda no período.")}>
        {totais.por_forma.map((f) => (
          <tr key={f.nome} className="border-b border-border/60">
            <td className="py-1">{f.nome}</td>
            <td className="py-1 text-right text-text-muted">{f.quantidade}</td>
            <td className="py-1 text-right tabular-nums">{formatCents(f.total_cents, moeda)}</td>
            <td className="py-1 text-right text-text-muted">
              {totais.faturado_cents > 0
                ? `${Math.round((f.total_cents / totais.faturado_cents) * 100)}%`
                : "—"}
            </td>
          </tr>
        ))}
      </Tabela>

      <Tabela titulo={t("Serviços que mais faturaram")} vazio={t("Nenhum item no período.")}>
        {totais.por_servico.map((sv) => (
          <tr key={sv.nome} className="border-b border-border/60">
            <td className="py-1">{sv.nome}</td>
            <td className="py-1 text-right text-text-muted">{sv.quantidade}</td>
            <td className="py-1 text-right tabular-nums" colSpan={2}>
              {formatCents(sv.total_cents, moeda)}
            </td>
          </tr>
        ))}
      </Tabela>

      <Tabela titulo={t("Clientes que mais gastaram")} vazio={t("Nenhum cliente no período.")}>
        {totais.por_cliente.map((c) => (
          <tr key={c.contact_id} className="border-b border-border/60">
            <td className="py-1">{nomeDoContato(c.contact_id)}</td>
            <td className="py-1 text-right text-text-muted">{c.comandas}</td>
            <td className="py-1 text-right tabular-nums" colSpan={2}>
              {formatCents(c.total_cents, moeda)}
            </td>
          </tr>
        ))}
      </Tabela>

      <Tabela titulo={t("Comissão por pessoa")} vazio={t("Nenhuma comissão no período.")}>
        {totais.por_profissional.map((p) => (
          <tr key={p.attendant_user_id ?? "sem"} className="border-b border-border/60">
            <td className="py-1">{nomeDe(p.attendant_user_id)}</td>
            <td className="py-1 text-right text-text-muted">{p.itens}</td>
            <td className="py-1 text-right tabular-nums" colSpan={2}>
              {formatCents(p.comissao_cents, moeda)}
            </td>
          </tr>
        ))}
      </Tabela>
    </>
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
