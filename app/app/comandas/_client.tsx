"use client";
/**
 * O balcão.
 *
 * Lista à esquerda, comanda aberta à direita, na mesma tela. Não são duas
 * páginas porque quem está no balcão precisa lançar um item e ver o total mudar
 * sem perder de vista a fila do dia.
 *
 * ⚠️ O TOTAL DE UMA COMANDA ABERTA VEM DA API, e não de uma soma local paralela.
 * `sales.total_cents` só é gravado na finalização, e a rota devolve o derivado —
 * recalcular aqui criaria um segundo número para a mesma pergunta, e o da tela
 * seria o que a pessoa acredita.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { formatCents, parseReaisToCents } from "@/lib/money";

import { AtendimentosSemComanda, type Pendente } from "./_pendentes";

type Item = {
  id: string;
  description: string;
  quantity: number;
  unit_price_cents: number;
  discount_cents: number;
  total_cents: number;
  commission_percent: number;
  attendant_user_id: string | null;
  event_type_id: string | null;
};

type Comanda = {
  id: string;
  number: number;
  status: "open" | "finalized" | "cancelled";
  contact_id: string | null;
  discount_cents: number;
  total_cents: number;
  currency: string;
  notes: string | null;
  finalized_at: string | null;
  reversed_at: string | null;
  sale_items?: Item[];
};

type Forma = { id: string; name: string; account_id: string | null };
type Tipo = { id: string; name: string; default_price_cents: number | null };

const ROTULO_DO_STATUS: Record<Comanda["status"], string> = {
  open: "Aberta",
  finalized: "Finalizada",
  cancelled: "Cancelada",
};

export function Comandas({
  podeLancar,
  podeEstornar,
}: {
  podeLancar: boolean;
  podeEstornar: boolean;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [abertaId, setAbertaId] = useState<string | null>(null);

  const lista = useQuery({
    queryKey: ["comandas"],
    queryFn: async () => (await apiClient.get<{ data: Comanda[] }>("/api/v1/financeiro/comandas")).data,
  });

  const detalhe = useQuery({
    queryKey: ["comandas", abertaId],
    enabled: Boolean(abertaId),
    queryFn: async () =>
      (await apiClient.get<{ data: Comanda }>(`/api/v1/financeiro/comandas/${abertaId}`)).data,
  });

  const formas = useQuery({
    queryKey: ["financeiro", "catalogo", "formas_de_pagamento"],
    queryFn: async () =>
      (await apiClient.get<{ data: Forma[] }>("/api/v1/financeiro/catalogo/formas_de_pagamento"))
        .data,
  });

  const tipos = useQuery({
    queryKey: ["agenda", "tipos"],
    queryFn: async () => (await apiClient.get<{ data: Tipo[] }>("/api/v1/agenda/tipos")).data,
  });

  const recarregar = () => {
    void qc.invalidateQueries({ queryKey: ["comandas"] });
    // A lista de pendentes encolhe a cada comanda aberta a partir de um
    // agendamento. Sem invalidar, o atendimento recém-faturado continuaria
    // oferecido para faturar de novo.
    void qc.invalidateQueries({ queryKey: ["comandas", "pendentes"] });
    // A finalização dá o ponto de fidelidade. Sem invalidar, o saldo ao lado do
    // número da comanda continuaria mostrando o de antes da venda.
    void qc.invalidateQueries({ queryKey: ["fidelidade"] });
  };

  const abrir = useMutation({
    mutationFn: () => apiClient.post<{ data: Comanda }>("/api/v1/financeiro/comandas", {}),
    onSuccess: (r) => {
      setAbertaId(r.data.id);
      recarregar();
    },
    onError: showApiError,
  });

  const incluirItem = useMutation({
    mutationFn: (corpo: Record<string, unknown>) =>
      apiClient.post(`/api/v1/financeiro/comandas/${abertaId}/itens`, corpo),
    onSuccess: recarregar,
    onError: showApiError,
  });

  const removerItem = useMutation({
    mutationFn: (itemId: string) =>
      apiClient.delete(`/api/v1/financeiro/comandas/${abertaId}/itens/${itemId}`),
    onSuccess: recarregar,
    onError: showApiError,
  });

  const alterar = useMutation({
    mutationFn: (corpo: Record<string, unknown>) =>
      apiClient.patch(`/api/v1/financeiro/comandas/${abertaId}`, corpo),
    onSuccess: recarregar,
    onError: showApiError,
  });

  const finalizar = useMutation({
    mutationFn: (corpo: Record<string, unknown>) =>
      apiClient.post(`/api/v1/financeiro/comandas/${abertaId}/finalizar`, corpo),
    onSuccess: recarregar,
    onError: showApiError,
  });

  const estornar = useMutation({
    mutationFn: (corpo: Record<string, unknown>) =>
      apiClient.post(`/api/v1/financeiro/comandas/${abertaId}/estornar`, corpo),
    onSuccess: recarregar,
    onError: showApiError,
  });

  const pendentes = useQuery({
    queryKey: ["comandas", "pendentes"],
    enabled: podeLancar,
    queryFn: async () =>
      (await apiClient.get<{ data: Pendente[] }>("/api/v1/financeiro/comandas/pendentes")).data,
  });

  const faturarLote = useMutation({
    mutationFn: (corpo: { appointment_ids: string[]; payment_method_id: string }) =>
      apiClient.post("/api/v1/financeiro/comandas/faturar-lote", corpo),
    onSuccess: recarregar,
    onError: showApiError,
  });

  const comanda = detalhe.data ?? null;
  const moeda = comanda?.currency ?? "BRL";

  // O saldo de pontos do cliente, ao lado da comanda dele. Sem isto, quem está
  // no balcão teria de abrir a ficha em outra tela para saber se o prêmio já
  // pode ser dado — e, na prática, não perguntaria.
  const fidelidade = useQuery({
    queryKey: ["fidelidade", comanda?.contact_id],
    enabled: Boolean(comanda?.contact_id),
    queryFn: async () =>
      (
        await apiClient.get<{ data: { saldo: number } }>(
          `/api/v1/financeiro/fidelidade?contact_id=${comanda?.contact_id}`,
        )
      ).data,
  });

  return (
    <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[320px_1fr]">
      <section className="flex min-h-0 flex-col gap-2">
        {podeLancar ? (
          <Button onClick={() => abrir.mutate()} disabled={abrir.isPending}>
            {t("Nova comanda")}
          </Button>
        ) : null}

        <ul className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto" data-testid="lista-de-comandas">
          {(lista.data ?? []).map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => setAbertaId(c.id)}
                data-testid={`comanda-${c.number}`}
                className={`flex w-full items-center justify-between rounded-md border p-2 text-left text-sm ${
                  abertaId === c.id ? "border-accent bg-surface-elevated" : "border-border"
                }`}
              >
                <span>
                  <span className="font-medium">#{c.number}</span>{" "}
                  <span className="text-xs text-text-muted">{t(ROTULO_DO_STATUS[c.status])}</span>
                </span>
                <span className="tabular-nums">{formatCents(c.total_cents, c.currency)}</span>
              </button>
            </li>
          ))}
          {lista.data?.length === 0 ? (
            <li className="p-2 text-sm text-text-muted">{t("Nenhuma comanda ainda.")}</li>
          ) : null}
        </ul>

        <AtendimentosSemComanda
          pendentes={pendentes.data ?? []}
          formas={formas.data ?? []}
          podeLancar={podeLancar}
          pendenteDeEnvio={faturarLote.isPending}
          onFaturar={(corpo) => faturarLote.mutate(corpo)}
        />
      </section>

      <section className="min-h-0 overflow-y-auto rounded-md border border-border p-3">
        {!comanda ? (
          <p className="text-sm text-text-muted">{t("Escolha uma comanda à esquerda.")}</p>
        ) : (
          <div className="flex flex-col gap-4">
            <header className="flex items-baseline justify-between">
              <h2 className="text-lg font-semibold">
                {t("Comanda")} #{comanda.number}
              </h2>
              <span className="text-sm text-text-muted">
                {comanda.contact_id && fidelidade.data ? (
                  <span className="mr-2" data-testid="saldo-de-fidelidade">
                    {fidelidade.data.saldo} {t("ponto(s)")}
                  </span>
                ) : null}
                {t(ROTULO_DO_STATUS[comanda.status])}
                {comanda.reversed_at ? ` · ${t("estornada")}` : ""}
              </span>
            </header>

            <table className="w-full text-sm">
              <tbody>
                {(comanda.sale_items ?? []).map((i) => (
                  <tr key={i.id} className="border-b border-border/60">
                    <td className="py-1">
                      {i.description}
                      {i.quantity > 1 ? ` ×${i.quantity}` : ""}
                      {i.commission_percent > 0 ? (
                        <span className="ml-2 text-xs text-text-muted">
                          {t("comissão")} {i.commission_percent}%
                        </span>
                      ) : null}
                    </td>
                    <td className="py-1 text-right tabular-nums">
                      {formatCents(i.total_cents, moeda)}
                    </td>
                    <td className="w-8 text-right">
                      {comanda.status === "open" && podeLancar ? (
                        <button
                          type="button"
                          aria-label={t("Remover item")}
                          onClick={() => removerItem.mutate(i.id)}
                          className="text-text-muted hover:text-text"
                        >
                          ×
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td className="pt-2 font-medium">{t("Total")}</td>
                  <td className="pt-2 text-right font-medium tabular-nums" data-testid="total-da-comanda">
                    {formatCents(comanda.total_cents, moeda)}
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>

            {comanda.status === "open" && podeLancar ? (
              <FormularioDeItem
                tipos={tipos.data ?? []}
                onIncluir={(corpo) => incluirItem.mutate(corpo)}
                pendente={incluirItem.isPending}
              />
            ) : null}

            {comanda.status === "open" && podeLancar ? (
              <Fechamento
                formas={formas.data ?? []}
                onFinalizar={(corpo) => finalizar.mutate(corpo)}
                onCancelar={() => alterar.mutate({ cancel: true })}
                pendente={finalizar.isPending}
                temContato={Boolean(comanda.contact_id)}
              />
            ) : null}

            {comanda.status === "finalized" && !comanda.reversed_at && podeEstornar ? (
              <Estorno onEstornar={(reason) => estornar.mutate({ reason })} pendente={estornar.isPending} />
            ) : null}
          </div>
        )}
      </section>
    </div>
  );
}

function FormularioDeItem({
  tipos,
  onIncluir,
  pendente,
}: {
  tipos: Tipo[];
  onIncluir: (corpo: Record<string, unknown>) => void;
  pendente: boolean;
}) {
  const t = useT();
  const [descricao, setDescricao] = useState("");
  const [preco, setPreco] = useState("");
  const [tipoId, setTipoId] = useState("");

  // O preço é digitado em reais e convertido AQUI. `parseReaisToCents` devolve
  // null no que não é dinheiro, e o botão fica desabilitado — em vez de mandar
  // `NaN` para uma rota que lança venda.
  const cents = parseReaisToCents(preco);
  const podeIncluir = descricao.trim().length > 0 && cents !== null && !pendente;

  return (
    <form
      className="flex flex-wrap items-end gap-2 border-t border-border pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!podeIncluir) return;
        onIncluir({
          description: descricao.trim(),
          unit_price_cents: cents,
          event_type_id: tipoId || null,
          quantity: 1,
        });
        setDescricao("");
        setPreco("");
        setTipoId("");
      }}
    >
      <label className="flex flex-col gap-1 text-xs text-text-muted">
        {t("Serviço")}
        <select
          value={tipoId}
          data-testid="item-servico"
          onChange={(e) => {
            setTipoId(e.target.value);
            // A descrição acompanha o serviço escolhido, e continua editável: o
            // que vai para a linha da venda é o TEXTO, congelado, porque o nome
            // do serviço muda e a venda de ontem não.
            const escolhido = tipos.find((x) => x.id === e.target.value);
            if (escolhido?.name) setDescricao(escolhido.name);
            // O preço padrão é SEMENTE, e por isso só preenche quando existe e
            // não sobrescreve o que alguém já digitou: quem digitou um valor
            // antes de escolher o serviço tinha um motivo.
            if (escolhido?.default_price_cents != null && preco.trim() === "") {
              setPreco((escolhido.default_price_cents / 100).toFixed(2));
            }
          }}
          className="rounded-md border border-border bg-surface-elevated p-2 text-sm text-text"
        >
          <option value="">{t("Avulso")}</option>
          {tipos.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-xs text-text-muted">
        {t("Descrição")}
        <input
          value={descricao}
          data-testid="item-descricao"
          onChange={(e) => setDescricao(e.target.value)}
          className="rounded-md border border-border bg-surface-elevated p-2 text-sm text-text"
        />
      </label>

      <label className="flex flex-col gap-1 text-xs text-text-muted">
        {t("Valor")}
        <input
          value={preco}
          inputMode="decimal"
          placeholder="0,00"
          data-testid="item-valor"
          onChange={(e) => setPreco(e.target.value)}
          className="w-28 rounded-md border border-border bg-surface-elevated p-2 text-sm text-text"
        />
      </label>

      <Button type="submit" disabled={!podeIncluir} data-testid="incluir-item">
        {t("Incluir")}
      </Button>
    </form>
  );
}

function Fechamento({
  formas,
  onFinalizar,
  onCancelar,
  pendente,
  temContato,
}: {
  formas: Forma[];
  onFinalizar: (corpo: Record<string, unknown>) => void;
  onCancelar: () => void;
  pendente: boolean;
  temContato: boolean;
}) {
  const t = useT();
  const [formaId, setFormaId] = useState("");
  const [pontos, setPontos] = useState("");
  const escolhida = formas.find((f) => f.id === formaId);

  // O ponto de fidelidade só existe se a comanda tem cliente: `loyalty_ledger`
  // exige `contact_id`, e oferecer o campo numa comanda avulsa seria um controle
  // que aceita número e não guarda nada.
  const pontosNumero = Number(pontos);
  const pontosValidos = pontos === "" || (Number.isInteger(pontosNumero) && pontosNumero >= 0);

  return (
    <div className="flex flex-wrap items-end gap-2 border-t border-border pt-3">
      <label className="flex flex-col gap-1 text-xs text-text-muted">
        {t("Forma de pagamento")}
        <select
          value={formaId}
          data-testid="forma-de-pagamento"
          onChange={(e) => setFormaId(e.target.value)}
          className="rounded-md border border-border bg-surface-elevated p-2 text-sm text-text"
        >
          <option value="">{t("Escolha")}</option>
          {formas.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      </label>

      {temContato ? (
        <label className="flex flex-col gap-1 text-xs text-text-muted">
          {t("Pontos de fidelidade")}
          <input
            value={pontos}
            inputMode="numeric"
            placeholder="0"
            data-testid="pontos-de-fidelidade"
            onChange={(e) => setPontos(e.target.value)}
            className="w-24 rounded-md border border-border bg-surface-elevated p-2 text-sm text-text"
          />
        </label>
      ) : null}

      <Button
        onClick={() =>
          onFinalizar({
            payment_method_id: formaId,
            loyalty_points: temContato && pontos !== "" ? pontosNumero : 0,
          })
        }
        disabled={!formaId || pendente || !pontosValidos}
        data-testid="finalizar-comanda"
      >
        {t("Finalizar")}
      </Button>

      <Button variant="ghost" onClick={onCancelar} data-testid="cancelar-comanda">
        {t("Cancelar comanda")}
      </Button>

      {/*
        O aviso ANTES do erro. Uma forma sem conta faz a finalização recusar com
        `forma_sem_conta`, e a pessoa no balcão descobriria isso com a cliente na
        frente. Aqui ela vê antes de tentar, e o texto diz onde resolver.
      */}
      {escolhida && !escolhida.account_id ? (
        <p className="w-full text-xs text-danger" data-testid="aviso-forma-sem-conta">
          {t(
            "Esta forma de pagamento ainda não tem conta de destino. Defina em Configurações › Financeiro.",
          )}
        </p>
      ) : null}
    </div>
  );
}

function Estorno({
  onEstornar,
  pendente,
}: {
  onEstornar: (motivo: string) => void;
  pendente: boolean;
}) {
  const t = useT();
  const [motivo, setMotivo] = useState("");

  return (
    <form
      className="flex flex-wrap items-end gap-2 border-t border-border pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (motivo.trim().length < 3) return;
        onEstornar(motivo.trim());
        setMotivo("");
      }}
    >
      <label className="flex flex-1 flex-col gap-1 text-xs text-text-muted">
        {/*
          O motivo é obrigatório na rota, e o rótulo diz por quê: um estorno sem
          motivo é um buraco no caixa que ninguém explica três meses depois.
        */}
        {t("Motivo do estorno")}
        <input
          value={motivo}
          data-testid="motivo-do-estorno"
          onChange={(e) => setMotivo(e.target.value)}
          className="rounded-md border border-border bg-surface-elevated p-2 text-sm text-text"
        />
      </label>
      <Button
        type="submit"
        variant="destructive"
        disabled={motivo.trim().length < 3 || pendente}
        data-testid="estornar-comanda"
      >
        {t("Estornar")}
      </Button>
    </form>
  );
}
