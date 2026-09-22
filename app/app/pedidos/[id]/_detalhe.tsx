"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { copyToClipboard } from "@/lib/clipboard";
import { comoMoeda, numeroDoPedido } from "@/lib/format/moeda";
import type { ItemDoPedido, PedidoComercial, StatusDoPedido } from "@/lib/schemas/pedidos";

import { PillDoStatus } from "../_pills";
import { FotosDoProduto } from "../../products/_fotos";

export interface ContatoDoPedido {
  id: string;
  nome: string;
  documento: string | null;
  fone: string | null;
  email: string | null;
  cidade: string | null;
  uf: string | null;
  /** Endereço em linha para sugerir como entrega (só sugere, nunca impõe). */
  endereco: string | null;
}

/** Avanço permitido direto da ficha (mesma ordem da lista). */
const PROXIMO_STATUS: Partial<Record<StatusDoPedido, StatusDoPedido>> = {
  rascunho: "aprovado",
  em_analise: "aprovado",
  aprovado: "faturado",
  faturado: "expedido",
  expedido: "entregue",
};

const ROTULO_ACAO_AVANCAR: Partial<Record<StatusDoPedido, string>> = {
  rascunho: "Aprovar pedido",
  em_analise: "Aprovar pedido",
  aprovado: "Faturar pedido",
  faturado: "Expedir pedido",
  expedido: "Marcar entregue",
};

/**
 * Seção FINANCEIRO da ficha do pedido — recebíveis gerados, com ação de
 * gerar e atalho para a central. O vínculo NF aparece quando existir.
 */
function FinanceiroDoPedido({ pedidoId }: { pedidoId: string }) {
  const t = useT();
  const [linhas, setLinhas] = React.useState<{ id: string; parcela_n: number; total_parcelas: number; valor_original_cents: number; vencimento: string; situacao: string; saldo_cents: number }[] | null>(null);
  const [gerando, setGerando] = React.useState(false);

  const recarregar = React.useCallback(async () => {
    try {
      const corpo = await apiClient.get<{ data: NonNullable<typeof linhas> }>(
        `/api/v1/financeiro/recebiveis?pedido_id=${pedidoId}&limit=100`,
      );
      setLinhas(corpo.data ?? []);
    } catch {
      setLinhas([]);
    }
  }, [pedidoId]);

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void recarregar();
  }, [recarregar]);

  async function gerar() {
    setGerando(true);
    try {
      await apiClient.post("/api/v1/financeiro/gerar", { order_id: pedidoId });
      toast.success(t("Financeiro gerado"));
      await recarregar();
    } catch (e) {
      showApiError(e);
    } finally {
      setGerando(false);
    }
  }

  return (
    <Card className="space-y-2 p-4">
      <p className="text-xs font-semibold tracking-wide text-muted-foreground">{t("FINANCEIRO")}</p>
      {linhas === null ? (
        <p className="text-xs text-muted-foreground">…</p>
      ) : linhas.length === 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-muted-foreground">{t("Sem financeiro gerado para este pedido.")}</p>
          <Button size="sm" variant="outline" onClick={() => void gerar()} disabled={gerando}>
            {gerando ? t("Gerando…") : t("Gerar financeiro")}
          </Button>
        </div>
      ) : (
        <ul className="space-y-1 text-sm">
          {linhas.map((l) => (
            <li key={l.id} className="flex flex-wrap items-center gap-2">
              <span className="tabular-nums">
                {l.parcela_n}/{l.total_parcelas} · {comoMoeda(l.valor_original_cents, "BRL")}
              </span>
              <span className="text-xs text-muted-foreground">
                {new Date(`${l.vencimento}T12:00:00Z`).toLocaleDateString()} · {l.situacao}
              </span>
              <span className="ml-auto">
                <Button size="sm" variant="ghost" asChild>
                  <Link href="/app/financeiro">{t("Ver financeiro")}</Link>
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/**
 * Seção FISCAL da ficha do pedido — notas vinculadas, com emitir, XML e
 * DANFE. Pedido sem NF não é erro: a seção mostra o vazio com a ação.
 */
function FiscalDoPedido({ pedidoId }: { pedidoId: string }) {
  const t = useT();
  const [notas, setNotas] = React.useState<
    { id: string; numero: number | null; serie: string; status: string; chave_acesso: string | null; erro: string | null }[] | null
  >(null);
  const [emitindo, setEmitindo] = React.useState(false);

  const recarregar = React.useCallback(async () => {
    try {
      const corpo = await apiClient.get<{ data: NonNullable<typeof notas> }>(
        `/api/v1/invoices?order_id=${pedidoId}`,
      );
      setNotas(corpo.data ?? []);
    } catch {
      setNotas([]);
    }
  }, [pedidoId]);

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void recarregar();
  }, [recarregar]);

  async function emitir() {
    setEmitindo(true);
    try {
      await apiClient.post("/api/v1/invoices", { order_id: pedidoId });
      toast.success(t("Nota enfileirada para emissão"));
      await recarregar();
    } catch (e) {
      showApiError(e);
    } finally {
      setEmitindo(false);
    }
  }

  return (
    <Card className="space-y-2 p-4">
      <p className="text-xs font-semibold tracking-wide text-muted-foreground">{t("FISCAL")}</p>
      {notas === null ? (
        <p className="text-xs text-muted-foreground">…</p>
      ) : notas.length === 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-muted-foreground">{t("Pedido sem nota fiscal.")}</p>
          <Button size="sm" variant="outline" onClick={() => void emitir()} disabled={emitindo}>
            {emitindo ? t("Enviando…") : t("Emitir NF-e")}
          </Button>
        </div>
      ) : (
        <ul className="space-y-1 text-sm">
          {notas.map((n) => (
            <li key={n.id} className="flex flex-wrap items-center gap-2">
              <span className="font-medium tabular-nums">
                {n.numero === null ? t("Sem número") : `${n.numero}/${n.serie}`}
              </span>
              <span className="text-xs text-muted-foreground">{n.status}</span>
              {n.erro && <span className="text-xs text-error-fg">{n.erro}</span>}
              <span className="ml-auto flex gap-2">
                <Button size="sm" variant="ghost" asChild>
                  <a href={`/api/v1/invoices/${n.id}/xml`} target="_blank" rel="noopener noreferrer">
                    XML
                  </a>
                </Button>
                <Button size="sm" variant="ghost" asChild>
                  <a href={`/api/v1/invoices/${n.id}/danfe`} target="_blank" rel="noopener noreferrer">
                    DANFE
                  </a>
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function LinhaDetalhe({ rotulo, valor }: { rotulo: string; valor: string }) {
  return (
    <div className="flex gap-3 text-sm">
      <dt className="w-36 shrink-0 text-muted-foreground">{rotulo}</dt>
      <dd className="font-medium">{valor || "—"}</dd>
    </div>
  );
}

export function DetalheDoPedido({
  pedido: inicial,
  itens,
  contato,
  nomeVendedor,
  nomeOrganizacao,
  podeEditar,
  podeExcluir,
}: {
  pedido: PedidoComercial;
  itens: ItemDoPedido[];
  contato: ContatoDoPedido | null;
  nomeVendedor: string | null;
  nomeOrganizacao: string;
  podeEditar: boolean;
  podeExcluir: boolean;
}) {
  const tagIdioma = useTagDeIdioma();
  const t = useT();
  const router = useRouter();
  const [pedido, setPedido] = React.useState(inicial);
  const [editando, setEditando] = React.useState(false);
  const [condicao, setCondicao] = React.useState(inicial.condicao_pagamento ?? "");
  const [endereco, setEndereco] = React.useState(inicial.endereco_entrega ?? "");
  const [transportadora, setTransportadora] = React.useState(inicial.transportadora_nome ?? "");
  const [obs, setObs] = React.useState(inicial.observacoes ?? "");
  const [timeline, setTimeline] = React.useState<{ acao: string; por: string; em: string }[] | null>(null);
  const [trocando, setTrocando] = React.useState(false);
  const [buscaCliente, setBuscaCliente] = React.useState("");
  const [candidatos, setCandidatos] = React.useState<{ id: string; display_name: string | null; name: string | null }[]>([]);

  React.useEffect(() => {
    let vivo = true;
    apiClient
      .get<{ data: { acao: string; por: string; em: string }[] }>(`/api/v1/commercial-orders/${inicial.id}/timeline`)
      .then((l) => {
        if (vivo) setTimeline(l.data ?? []);
      })
      .catch(() => {
        if (vivo) setTimeline([]);
      });
    return () => {
      vivo = false;
    };
  }, [inicial.id]);

  async function recarregar() {
    try {
      const corpo = await apiClient.get<{ data: PedidoComercial & { itens: ItemDoPedido[] } }>(
        `/api/v1/commercial-orders/${inicial.id}`,
      );
      setPedido(corpo.data);
    } catch (e) {
      showApiError(e);
    }
  }

  async function avancar() {
    const proximo = PROXIMO_STATUS[pedido.status as StatusDoPedido];
    if (!proximo) return;
    try {
      await apiClient.patch(`/api/v1/commercial-orders/${pedido.id}`, { status: proximo });
      toast.success("Status atualizado");
      await recarregar();
    } catch (e) {
      showApiError(e);
    }
  }

  async function duplicar() {
    try {
      const corpo = await apiClient.post<{ data: { numero: number } | null }>(
        `/api/v1/commercial-orders/${pedido.id}/duplicar`,
        {},
      );
      const novo = corpo?.data;
      if (!novo) throw new Error(t("O servidor não devolveu o pedido duplicado."));
      toast.success(t(`Duplicado como ${numeroDoPedido(novo.numero)}`));
    } catch (e) {
      showApiError(e);
    }
  }

  async function excluir() {
    if (!window.confirm(t("Excluir este pedido? Estoque baixado volta. Com NF ou em carga, é barrado com aviso."))) {
      return;
    }
    try {
      await apiClient.delete(`/api/v1/commercial-orders/${pedido.id}`);
      toast.success(t("Pedido excluído."));
      router.push("/app/pedidos");
    } catch (e) {
      showApiError(e);
    }
  }

  async function salvarDetalhes() {
    try {
      await apiClient.patch(`/api/v1/commercial-orders/${pedido.id}`, {
        condicao_pagamento: condicao.trim() || null,
        endereco_entrega: endereco.trim() || null,
        transportadora_nome: transportadora.trim() || null,
        observacoes: obs.trim() || null,
      });
      toast.success("Detalhes salvos");
      setEditando(false);
      await recarregar();
    } catch (e) {
      showApiError(e);
    }
  }

  async function buscarClientes(termo: string) {
    setBuscaCliente(termo);
    if (termo.trim().length < 2) {
      setCandidatos([]);
      return;
    }
    try {
      const qs = new URLSearchParams({ search: termo.trim(), limit: "6" });
      const corpo = await apiClient.get<{ data: { id: string; display_name: string | null; name: string | null }[] }>(
        `/api/v1/contacts?${qs}`,
      );
      setCandidatos(corpo.data ?? []);
    } catch (e) {
      showApiError(e);
    }
  }

  async function trocarCliente(contactId: string) {
    try {
      await apiClient.patch(`/api/v1/commercial-orders/${pedido.id}`, { contact_id: contactId });
      toast.success("Cliente trocado");
      setTrocando(false);
      setBuscaCliente("");
      setCandidatos([]);
      await recarregar();
    } catch (e) {
      showApiError(e);
    }
  }

  async function copiarLink() {
    const url = window.location.href;
    const ok = await copyToClipboard(url);
    if (ok) {
      toast.success(t("Link copiado"));
    } else {
      toast.error(t("Não foi possível copiar"));
    }
  }

  const resumoWhats = `${numeroDoPedido(pedido.numero)} — ${pedido.cliente_nome} — ${comoMoeda(pedido.total_cents, pedido.moeda)}`;
  const qtdTotal = itens.reduce((a, i) => a + i.quantidade, 0);
  const proximo = PROXIMO_STATUS[pedido.status as StatusDoPedido];

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4 sm:p-6">
      <Link href="/app/pedidos" className="text-sm text-muted-foreground underline underline-offset-4">
        {t("← Pedidos")}
      </Link>

      {/* Cabeçalho: número + pill, como no Mercos. */}
      <Card className="flex items-center justify-between gap-3 p-4">
        <p className="text-lg font-semibold">{numeroDoPedido(pedido.numero)}</p>
        <PillDoStatus status={pedido.status as StatusDoPedido} />
      </Card>

      {/* Ações */}
      <div className="flex flex-wrap gap-2">
        {podeEditar && proximo && (
          <Button size="sm" onClick={() => void avancar()}>
            {t(ROTULO_ACAO_AVANCAR[pedido.status as StatusDoPedido] ?? "Avançar")}
          </Button>
        )}
        <Button size="sm" variant="outline" asChild>
          <Link href={`/api/v1/commercial-orders/${pedido.id}/pdf`} target="_blank" rel="noopener noreferrer">
            {t("Visualizar PDF")}
          </Link>
        </Button>
        <Button size="sm" variant="outline" asChild>
          <a
            href={`https://wa.me/?text=${encodeURIComponent(resumoWhats)}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t("Enviar por WhatsApp")}
          </a>
        </Button>
        {contato?.email && (
          <Button size="sm" variant="outline" asChild>
            <a href={`mailto:${contato.email}?subject=${encodeURIComponent(resumoWhats)}`}>{t("Enviar por e-mail")}</a>
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={copiarLink}>
          {t("Copiar link do pedido")}
        </Button>
        <Button size="sm" variant="outline" asChild>
          <Link href={`/app/pedidos/imprimir?ids=${pedido.id}`}>
            {t("Imprimir pedido")}
          </Link>
        </Button>
        {podeEditar && (
          <Button size="sm" variant="outline" onClick={() => void duplicar()}>
            {t("Duplicar")}
          </Button>
        )}
        {podeExcluir && (
          <Button size="sm" variant="destructive" onClick={() => void excluir()}>
            {t("Excluir pedido")}
          </Button>
        )}
      </div>

      {/* CLIENTE */}
      <Card className="space-y-2 p-4">
        <p className="text-xs font-semibold tracking-wide text-muted-foreground">{t("CLIENTE")}</p>
        <p className="font-medium">
          {contato ? (
            <Link href={`/app/contacts/${contato.id}`} className="underline underline-offset-4">
              {pedido.cliente_nome}
            </Link>
          ) : (
            pedido.cliente_nome
          )}
          {pedido.cliente_documento && (
            <span className="text-muted-foreground"> — {pedido.cliente_documento}</span>
          )}
        </p>
        {contato?.fone && <p className="text-sm">{contato.fone}</p>}
        {contato?.email && <p className="text-sm">{contato.email}</p>}
        {(contato?.cidade || contato?.uf) && (
          <p className="text-sm text-muted-foreground">
            {[contato.cidade, contato.uf].filter(Boolean).join(", ")}
          </p>
        )}
        {podeEditar &&
          (trocando ? (
            <div className="space-y-2 pt-1">
              <Input
                value={buscaCliente}
                onChange={(e) => void buscarClientes(e.target.value)}
                placeholder={t("Buscar cliente por nome, telefone ou documento…")}
              />
              {candidatos.length > 0 && (
                <ul className="divide-y rounded-2xl border">
                  {candidatos.map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        className="block w-full px-3 py-2 text-left text-sm hover:bg-accent"
                        onClick={() => void trocarCliente(c.id)}
                      >
                        {c.display_name ?? c.name ?? "—"}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <Button size="sm" variant="outline" onClick={() => setTrocando(false)}>
                {t("Cancelar")}
              </Button>
            </div>
          ) : (
            <Button size="sm" variant="outline" onClick={() => setTrocando(true)}>
              {t("Trocar cliente")}
            </Button>
          ))}
      </Card>

      {/* ORGANIZAÇÃO (a "representada" do Mercos). */}
      {nomeOrganizacao && (
        <Card className="space-y-1 p-4">
          <p className="text-xs font-semibold tracking-wide text-muted-foreground">{t("EMPRESA")}</p>
          <p className="font-medium">{nomeOrganizacao}</p>
        </Card>
      )}

      {/* PRODUTOS */}
      <Card className="p-4">
        <p className="mb-3 text-xs font-semibold tracking-wide text-muted-foreground">{t("PRODUTOS")}</p>
        {itens.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("Sem itens.")}</p>
        ) : (
          <div className="overflow-x-auto rounded-3xl border">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead>{t("Foto")}</TableHead>
                  <TableHead>{t("Código")}</TableHead>
                  <TableHead>{t("Descrição")}</TableHead>
                  <TableHead className="text-right">{t("Qtde.")}</TableHead>
                  <TableHead className="text-right">{t("Preço un.")}</TableHead>
                  <TableHead className="text-right">{t("Desc. %")}</TableHead>
                  <TableHead className="text-right">{t("Subtotal")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {itens.map((it) => (
                  <TableRow key={it.id}>
                    <TableCell>
                      {it.product_id ? (
                        <FotosDoProduto productId={it.product_id} podeEditar={false} />
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{it.produto_codigo || "—"}</TableCell>
                    <TableCell className="font-medium">{it.produto_nome}</TableCell>
                    <TableCell className="text-right tabular-nums">{it.quantidade}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {comoMoeda(it.preco_unit_cents, pedido.moeda)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {Number(it.desconto_pct) > 0 ? `${Number(it.desconto_pct)} %` : "—"}
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {comoMoeda(it.subtotal_cents, pedido.moeda)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        <div className="mt-3 flex flex-wrap gap-6 border-t pt-3 text-sm">
          <p>
            <span className="text-muted-foreground">{t("Itens no pedido")}: </span>
            <strong>{itens.length}</strong>
          </p>
          <p>
            <span className="text-muted-foreground">{t("Quantidade total")}: </span>
            <strong>{qtdTotal}</strong>
          </p>
          <p className="ml-auto text-base">
            <span className="text-muted-foreground">{t("Valor total")}: </span>
            <strong className="tabular-nums">{comoMoeda(pedido.total_cents, pedido.moeda)}</strong>
          </p>
        </div>
      </Card>

      {/* DETALHES DO PEDIDO */}
      <Card className="space-y-4 p-4">
        <p className="text-xs font-semibold tracking-wide text-muted-foreground">{t("DETALHES DO PEDIDO")}</p>
        <dl className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          <LinhaDetalhe rotulo={t("Nº do pedido")} valor={numeroDoPedido(pedido.numero)} />
          <LinhaDetalhe
            rotulo={t("Data da emissão")}
            valor={new Date(pedido.created_at).toLocaleDateString(tagIdioma)}
          />
          <LinhaDetalhe rotulo={t("Vendedor")} valor={nomeVendedor ?? (pedido.vendedor_user_id ?? "").slice(0, 8) ?? "—"} />
          <LinhaDetalhe rotulo={t("Cond. de pagamento")} valor={pedido.condicao_pagamento ?? ""} />
          <LinhaDetalhe rotulo={t("End. de entrega")} valor={pedido.endereco_entrega ?? ""} />
          <LinhaDetalhe rotulo={t("Transportadora")} valor={pedido.transportadora_nome ?? ""} />
          <LinhaDetalhe rotulo={t("Origem")} valor={pedido.origem} />
          <LinhaDetalhe
            rotulo={t("Atualizado em")}
            valor={new Date(pedido.updated_at).toLocaleDateString(tagIdioma)}
          />
        </dl>
        {(pedido.observacoes || pedido.obs_interna) && (
          <div className="space-y-1 text-sm">
            {pedido.observacoes && (
              <p>
                <span className="text-muted-foreground">{t("Observações")}: </span>
                {pedido.observacoes}
              </p>
            )}
            {pedido.obs_interna && (
              <p>
                <span className="text-muted-foreground">{t("Interna")}: </span>
                {pedido.obs_interna}
              </p>
            )}
          </div>
        )}
        {podeEditar &&
          (editando ? (
            <div className="grid gap-2 sm:grid-cols-2">
              <Input value={condicao} onChange={(e) => setCondicao(e.target.value)} placeholder={t("Condição de pagamento")} />
              <Input value={transportadora} onChange={(e) => setTransportadora(e.target.value)} placeholder={t("Transportadora")} />
              <Input
                value={endereco}
                onChange={(e) => setEndereco(e.target.value)}
                placeholder={t("Endereço de entrega")}
                className="sm:col-span-2"
              />
              {!endereco.trim() && contato?.endereco && (
                <div className="sm:col-span-2">
                  <Button size="sm" variant="outline" onClick={() => setEndereco(contato.endereco ?? "")}>
                    {t("Usar endereço do cliente")}
                  </Button>
                </div>
              )}
              <Input
                value={obs}
                onChange={(e) => setObs(e.target.value)}
                placeholder={t("Observações")}
                className="sm:col-span-2"
              />
              <div className="flex gap-2 sm:col-span-2">
                <Button size="sm" onClick={() => void salvarDetalhes()}>
                  {t("Salvar")}
                </Button>
                <Button size="sm" variant="outline" onClick={() => setEditando(false)}>
                  {t("Cancelar")}
                </Button>
              </div>
            </div>
          ) : (
            <Button size="sm" variant="outline" onClick={() => setEditando(true)}>
              {t("Alterar detalhes do pedido")}
            </Button>
          ))}
      </Card>

      {/* FINANCEIRO */}
      <FinanceiroDoPedido pedidoId={pedido.id} />

      {/* FISCAL */}
      <FiscalDoPedido pedidoId={pedido.id} />

      {/* HISTÓRICO */}
      <Card className="p-4">
        <p className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground">{t("HISTÓRICO")}</p>
        {timeline === null ? (
          <p className="text-xs text-muted-foreground">…</p>
        ) : timeline.length === 0 ? (
          <p className="text-xs text-muted-foreground">—</p>
        ) : (
          <ul className="space-y-1 text-xs">
            {timeline.map((l, i) => (
              <li key={i} className="flex gap-2">
                <span className="font-medium">{l.acao}</span>
                <span className="text-muted-foreground">
                  {l.por} · {new Date(l.em).toLocaleString(tagIdioma)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
