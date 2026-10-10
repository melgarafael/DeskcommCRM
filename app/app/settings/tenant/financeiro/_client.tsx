"use client";
/**
 * O catálogo financeiro na tela.
 *
 * Três listas na mesma página, e não três telas: elas se leem juntas. A forma de
 * pagamento aponta para uma conta, e conferir isso pulando entre abas é como o
 * erro passa — "Pix cai no Caixa" só se percebe vendo os dois lado a lado.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";

import { RegrasDeComissao, type Pessoa, type Regra, type Servico } from "./_comissao";
import { Recorrencias, type Recorrencia } from "./_recorrencias";

type Conta = {
  id: string;
  name: string;
  kind: string;
  opening_balance_cents: number;
  currency: string;
};
type Forma = { id: string; name: string; account_id: string | null };
type Plano = { id: string; name: string; direction: "in" | "out" };

const TIPO_DE_CONTA: Record<string, string> = {
  cash: "Caixa",
  bank: "Banco",
  other: "Outra",
};

function useCatalogo<T>(tipo: string, enabled = true) {
  return useQuery({
    enabled,
    queryKey: ["financeiro", "catalogo", tipo],
    queryFn: async () =>
      (await apiClient.get<{ data: T[] }>(`/api/v1/financeiro/catalogo/${tipo}`)).data,
  });
}

export function CatalogoFinanceiro({
  podeEditar,
  comissaoDisponivel = false,
}: {
  podeEditar: boolean;
  /** Regra de comissão é do módulo `financeiro` (#1907): sem ele, a seção some. */
  comissaoDisponivel?: boolean;
}) {
  const t = useT();
  const qc = useQueryClient();
  const contas = useCatalogo<Conta>("contas");
  const formas = useCatalogo<Forma>("formas_de_pagamento");
  const planos = useCatalogo<Plano>("planos_de_conta");
  const regras = useCatalogo<Regra>("regras_de_comissao", comissaoDisponivel);
  const recorrencias = useCatalogo<Recorrencia>("recorrencias");

  // A regra guarda IDs; a lista precisa de nomes. Buscar aqui evita que o
  // catálogo genérico no servidor tenha de conhecer equipe e agenda.
  const pessoas = useQuery({
    queryKey: ["team", "assignable"],
    queryFn: async () => (await apiClient.get<{ data: Pessoa[] }>("/api/v1/team/assignable")).data,
  });
  const servicos = useQuery({
    queryKey: ["agenda", "tipos"],
    queryFn: async () => (await apiClient.get<{ data: Servico[] }>("/api/v1/agenda/tipos")).data,
  });

  const invalidar = (tipo: string) =>
    void qc.invalidateQueries({ queryKey: ["financeiro", "catalogo", tipo] });

  const criar = useMutation({
    mutationFn: ({ tipo, corpo }: { tipo: string; corpo: Record<string, unknown> }) =>
      apiClient.post(`/api/v1/financeiro/catalogo/${tipo}`, corpo),
    onSuccess: (_d, v) => invalidar(v.tipo),
    onError: showApiError,
  });
  const inativar = useMutation({
    mutationFn: ({ tipo, id }: { tipo: string; id: string }) =>
      apiClient.delete(`/api/v1/financeiro/catalogo/${tipo}`, { id }),
    onSuccess: (_d, v) => invalidar(v.tipo),
    onError: showApiError,
  });
  /*
   * EDITAR (#2641): a rota PATCH já existia e validava sozinha — quem não a
   * chamava era a tela, e o item só tinha "Desativar". O corpo é o MESMO da
   * criação + o id, então a edição herda a validação e a régua `manager` da
   * criação sem repetir nenhuma das duas aqui.
   */
  const editar = useMutation({
    mutationFn: ({
      tipo,
      id,
      corpo,
    }: {
      tipo: string;
      id: string;
      corpo: Record<string, unknown>;
    }) => apiClient.patch(`/api/v1/financeiro/catalogo/${tipo}`, { ...corpo, id }),
    onSuccess: (_d, v) => invalidar(v.tipo),
    onError: showApiError,
  });

  const [nomeConta, setNomeConta] = useState("");
  const [tipoConta, setTipoConta] = useState("cash");
  const [nomeForma, setNomeForma] = useState("");
  const [contaDaForma, setContaDaForma] = useState("");
  const [nomePlano, setNomePlano] = useState("");
  const [direcaoPlano, setDirecaoPlano] = useState<"in" | "out" | "">("");

  // Uma edição por seção, e não uma global: os três formulários são
  // independentes e podem ficar abertos ao mesmo tempo sem se atropelarem.
  const [editandoConta, setEditandoConta] = useState<string | null>(null);
  const [editandoForma, setEditandoForma] = useState<string | null>(null);
  const [editandoPlano, setEditandoPlano] = useState<string | null>(null);

  const limparConta = () => {
    setNomeConta("");
    setTipoConta("cash");
    setEditandoConta(null);
  };
  const limparForma = () => {
    setNomeForma("");
    setContaDaForma("");
    setEditandoForma(null);
  };
  const limparPlano = () => {
    setNomePlano("");
    setDirecaoPlano("");
    setEditandoPlano(null);
  };

  const nomeDaConta = (id: string | null) =>
    id ? (contas.data?.find((c) => c.id === id)?.name ?? t("conta removida")) : null;

  return (
    <div className="space-y-4" data-testid="catalogo-financeiro">
      {/* ─── contas ─────────────────────────────────────────────────── */}
      <section className="space-y-3 rounded-xl border p-4">
        <h2 className="font-semibold">{t("Contas")}</h2>
        <p className="text-sm text-text-muted">
          {t(
            "Onde o dinheiro fica. O saldo que aparece nos relatórios é sempre somado dos lançamentos — o valor aqui é só o ponto de partida.",
          )}
        </p>
        {podeEditar ? (
          <div className="flex flex-wrap items-end gap-2">
            <input
              aria-label={t("Nome da conta")}
              className="min-h-11 rounded-md border p-2"
              placeholder={t("Ex.: Caixa")}
              value={nomeConta}
              onChange={(e) => setNomeConta(e.target.value)}
            />
            <select
              aria-label={t("Tipo da conta")}
              className="min-h-11 rounded-md border p-2"
              value={tipoConta}
              onChange={(e) => setTipoConta(e.target.value)}
            >
              {Object.entries(TIPO_DE_CONTA).map(([v, r]) => (
                <option key={v} value={v}>
                  {t(r)}
                </option>
              ))}
            </select>
            <Button
              className="min-h-11"
              disabled={nomeConta.trim().length < 2 || criar.isPending || editar.isPending}
              onClick={() => {
                const corpo = { name: nomeConta.trim(), kind: tipoConta };
                if (editandoConta) {
                  editar.mutate(
                    { tipo: "contas", id: editandoConta, corpo },
                    { onSuccess: limparConta },
                  );
                } else {
                  criar.mutate({ tipo: "contas", corpo }, { onSuccess: () => setNomeConta("") });
                }
              }}
            >
              {editandoConta ? t("Salvar") : t("Adicionar conta")}
            </Button>
            {editandoConta ? (
              <Button variant="ghost" className="min-h-11" onClick={limparConta}>
                {t("Cancelar")}
              </Button>
            ) : null}
          </div>
        ) : null}
        <Lista
          carregando={contas.isLoading}
          vazio={t("Nenhuma conta cadastrada.")}
          itens={contas.data ?? []}
          rotulo={(c) => `${c.name} · ${t(TIPO_DE_CONTA[c.kind] ?? c.kind)}`}
          podeEditar={podeEditar}
          aoRemover={(id) => inativar.mutate({ tipo: "contas", id })}
          aoEditar={(c) => {
            setNomeConta(c.name);
            setTipoConta(c.kind);
            setEditandoConta(c.id);
          }}
        />
      </section>

      {/* ─── formas de pagamento ────────────────────────────────────── */}
      <section className="space-y-3 rounded-xl border p-4">
        <h2 className="font-semibold">{t("Formas de pagamento")}</h2>
        <p className="text-sm text-text-muted">
          {t(
            "Como o cliente paga. A conta escolhida aqui é onde esse dinheiro entra quando a comanda é fechada.",
          )}
        </p>
        {podeEditar ? (
          <div className="flex flex-wrap items-end gap-2">
            <input
              aria-label={t("Nome da forma de pagamento")}
              className="min-h-11 rounded-md border p-2"
              placeholder={t("Ex.: Pix")}
              value={nomeForma}
              onChange={(e) => setNomeForma(e.target.value)}
            />
            <select
              aria-label={t("Conta de destino")}
              className="min-h-11 rounded-md border p-2"
              value={contaDaForma}
              onChange={(e) => setContaDaForma(e.target.value)}
            >
              <option value="">{t("Decidir depois")}</option>
              {(contas.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <Button
              className="min-h-11"
              disabled={nomeForma.trim().length < 2 || criar.isPending || editar.isPending}
              onClick={() => {
                const nome = nomeForma.trim();
                if (editandoForma) {
                  // Na edição a conta vai SEMPRE: omiti-la quando a pessoa
                  // escolhe "Decidir depois" deixaria a conta antiga no lugar.
                  editar.mutate(
                    {
                      tipo: "formas_de_pagamento",
                      id: editandoForma,
                      corpo: { name: nome, account_id: contaDaForma || null },
                    },
                    { onSuccess: limparForma },
                  );
                } else {
                  criar.mutate(
                    {
                      tipo: "formas_de_pagamento",
                      corpo: { name: nome, ...(contaDaForma ? { account_id: contaDaForma } : {}) },
                    },
                    { onSuccess: () => setNomeForma("") },
                  );
                }
              }}
            >
              {editandoForma ? t("Salvar") : t("Adicionar forma")}
            </Button>
            {editandoForma ? (
              <Button variant="ghost" className="min-h-11" onClick={limparForma}>
                {t("Cancelar")}
              </Button>
            ) : null}
          </div>
        ) : null}
        <Lista
          carregando={formas.isLoading}
          vazio={t("Nenhuma forma de pagamento cadastrada.")}
          itens={formas.data ?? []}
          rotulo={(f) =>
            // Sem conta é AVISO, não detalhe: essa forma não consegue fechar
            // comanda, e quem cadastrou precisa ver isso sem abrir nada.
            `${f.name} → ${nomeDaConta(f.account_id) ?? `⚠️ ${t("sem conta definida")}`}`
          }
          podeEditar={podeEditar}
          aoRemover={(id) => inativar.mutate({ tipo: "formas_de_pagamento", id })}
          aoEditar={(f) => {
            setNomeForma(f.name);
            setContaDaForma(f.account_id ?? "");
            setEditandoForma(f.id);
          }}
        />
      </section>

      {/* ─── plano de contas ────────────────────────────────────────── */}
      <section className="space-y-3 rounded-xl border p-4">
        <h2 className="font-semibold">{t("Plano de contas")}</h2>
        <p className="text-sm text-text-muted">
          {t("Como cada lançamento é classificado. Entrada e saída são coisas diferentes.")}
        </p>
        {podeEditar ? (
          <div className="flex flex-wrap items-end gap-2">
            <input
              aria-label={t("Nome do plano de contas")}
              className="min-h-11 rounded-md border p-2"
              placeholder={t("Ex.: Serviços")}
              value={nomePlano}
              onChange={(e) => setNomePlano(e.target.value)}
            />
            {/*
              Começa VAZIO e obriga a escolher. O sistema de origem tinha as 17
              linhas como "débito", inclusive "Serviços" e "Comissão" — um campo
              que existia e não distinguia nada, porque quem cadastra depressa
              aceita o que já vem preenchido.
            */}
            <select
              aria-label={t("Entrada ou saída")}
              className="min-h-11 rounded-md border p-2"
              value={direcaoPlano}
              onChange={(e) => setDirecaoPlano(e.target.value as "in" | "out" | "")}
            >
              <option value="">{t("Entrada ou saída?")}</option>
              <option value="in">{t("Entrada")}</option>
              <option value="out">{t("Saída")}</option>
            </select>
            <Button
              className="min-h-11"
              disabled={
                nomePlano.trim().length < 2 || !direcaoPlano || criar.isPending || editar.isPending
              }
              onClick={() => {
                const corpo = { name: nomePlano.trim(), direction: direcaoPlano };
                if (editandoPlano) {
                  editar.mutate(
                    { tipo: "planos_de_conta", id: editandoPlano, corpo },
                    { onSuccess: limparPlano },
                  );
                } else {
                  criar.mutate(
                    { tipo: "planos_de_conta", corpo },
                    {
                      onSuccess: () => {
                        setNomePlano("");
                        setDirecaoPlano("");
                      },
                    },
                  );
                }
              }}
            >
              {editandoPlano ? t("Salvar") : t("Adicionar plano")}
            </Button>
            {editandoPlano ? (
              <Button variant="ghost" className="min-h-11" onClick={limparPlano}>
                {t("Cancelar")}
              </Button>
            ) : null}
          </div>
        ) : null}
        <Lista
          carregando={planos.isLoading}
          vazio={t("Nenhum plano de contas cadastrado.")}
          itens={planos.data ?? []}
          rotulo={(p) => `${p.name} · ${p.direction === "in" ? t("Entrada") : t("Saída")}`}
          podeEditar={podeEditar}
          aoRemover={(id) => inativar.mutate({ tipo: "planos_de_conta", id })}
          aoEditar={(p) => {
            setNomePlano(p.name);
            setDirecaoPlano(p.direction);
            setEditandoPlano(p.id);
          }}
        />
      </section>

      {comissaoDisponivel && (
        <RegrasDeComissao
          regras={regras.data ?? []}
          pessoas={pessoas.data ?? []}
          servicos={servicos.data ?? []}
          podeEditar={podeEditar}
          carregando={regras.isLoading}
          onCriar={(corpo) => criar.mutate({ tipo: "regras_de_comissao", corpo })}
          onEditar={(id, corpo, aoSalvar) =>
            editar.mutate({ tipo: "regras_de_comissao", id, corpo }, { onSuccess: aoSalvar })
          }
          onInativar={(id) => inativar.mutate({ tipo: "regras_de_comissao", id })}
        />
      )}

      <Recorrencias
        recorrencias={recorrencias.data ?? []}
        contas={(contas.data ?? []).map((c) => ({ id: c.id, name: c.name }))}
        podeEditar={podeEditar}
        carregando={recorrencias.isLoading}
        onCriar={(corpo) => criar.mutate({ tipo: "recorrencias", corpo })}
        onEditar={(id, corpo, aoSalvar) =>
          editar.mutate({ tipo: "recorrencias", id, corpo }, { onSuccess: aoSalvar })
        }
        onInativar={(id) => inativar.mutate({ tipo: "recorrencias", id })}
      />
    </div>
  );
}

/**
 * A LISTA DE ITENS — e o botão que faltava (#2641).
 *
 * Antes só havia "Desativar": corrigir um nome era desativar e cadastrar de
 * novo, e o catálogo acumulava duplicata inativa. "Editar" preenche o
 * formulário DA SEÇÃO com o item, e o Salvar vai pelo PATCH — mesma
 * validação, mesma régua `manager`, nenhum DELETE no caminho.
 */
function Lista<T extends { id: string }>({
  carregando,
  vazio,
  itens,
  rotulo,
  podeEditar,
  aoRemover,
  aoEditar,
}: {
  carregando: boolean;
  vazio: string;
  itens: T[];
  /** O texto da linha, montado por quem conhece a entidade (cada uma tem campos diferentes). */
  rotulo: (item: T) => string;
  podeEditar: boolean;
  aoRemover: (id: string) => void;
  aoEditar?: (item: T) => void;
}) {
  const t = useT();
  if (carregando) return <p>{t("Carregando…")}</p>;
  if (itens.length === 0) return <p className="text-sm text-text-muted">{vazio}</p>;
  return (
    <ul className="space-y-1">
      {itens.map((i) => (
        <li key={i.id} className="flex items-center justify-between gap-2 text-sm">
          <span>{rotulo(i)}</span>
          {podeEditar ? (
            <span className="flex items-center gap-1">
              {aoEditar ? (
                <Button variant="ghost" className="min-h-11" onClick={() => aoEditar(i)}>
                  {t("Editar")}
                </Button>
              ) : null}
              {/* "Remover" seria mentira: a linha continua, inativa, porque
                  lançamento antigo aponta para ela. */}
              <Button variant="ghost" className="min-h-11" onClick={() => aoRemover(i.id)}>
                {t("Desativar")}
              </Button>
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
