"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { nexusToast } from "@/components/nexus-ui/feedback/nexus-toast";
import { NexusSteps } from "@/components/nexus-ui/forms/NexusSteps";
import { useT } from "@/hooks/i18n/useT";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { apiClient } from "@/lib/api/client";
import { comoMoeda } from "@/lib/format/moeda";
import { enderecoEmLinha } from "@/lib/contacts/endereco-em-linha";
import { precoParaCentavos, type Produto } from "@/lib/schemas/produtos";
import { calcularParcelas, subtotalDoItem } from "@/lib/schemas/pedidos";
import { CustomerSelector, type ContatoOpcao } from "./_cliente";
import { ProductSearch, type PrecoDeTabela, type UltimoPreco } from "./_produtos";
import { OrderItems, type LinhaDoPedido } from "./_itens";
import { OrderSummary } from "./_resumo";
import { haQuantoTempo, useAutosaveDraft } from "./_autosave";
import { useOrderShortcuts } from "./_atalhos";

interface TextosBase {
  titulo: string;
  subtitulo: string;
  cliente: string;
  buscarCliente: string;
  clienteAvulso: string;
  condicao: string;
  observacoes: string;
  obsInterna: string;
  endereco: string;
  enderecoExemplo: string;
  transportadora: string;
  tabelaPreco: string;
  semTabela: string;
  relacionados: string;
  adicionar: string;
  historico: string;
  rascunhoRestaurado: string;
  produtos: string;
  buscarProduto: string;
  subtotal: string;
  desconto: string;
  frete: string;
  total: string;
  margem: string;
  comissao: string;
  aguardandoAprovacao: string;
  salvarRascunho: string;
  finalizar: string;
  revisar: string;
  pedidoCriado: string;
}

/**
 * O EDITOR (§2–3): 70/30 no desktop, barra sticky no mobile.
 *
 * Monta o rascunho local (com autosave) e só fala com o servidor no
 * Salvar/Finalizar — o backend recalcula tudo e barra o que for inválido.
 * Preço, estoque, crédito e aprovação NUNCA são decididos aqui.
 */
export function OrderEditor({
  produtos,
  contatos,
  tabelas,
  verMargem,
  comissaoPct,
  textos,
}: {
  produtos: Produto[];
  contatos: ContatoOpcao[];
  tabelas: { id: string; nome: string; desconto_pct: number }[];
  verMargem: boolean;
  comissaoPct: number | null;
  textos: TextosBase;
}) {
  const t = useT();
  const router = useRouter();
  const buscaRef = React.useRef<HTMLInputElement | null>(null);

  const [contatoId, setContatoId] = React.useState<string | null>(null);
  const [clienteNome, setClienteNome] = React.useState("");
  const [linhas, setLinhas] = React.useState<LinhaDoPedido[]>([]);
  const [condicao, setCondicao] = React.useState("");
  const [observacoes, setObservacoes] = React.useState("");
  const [obsInterna, setObsInterna] = React.useState("");
  const [endereco, setEndereco] = React.useState("");
  const [transportadora, setTransportadora] = React.useState("");
  const [tabelaId, setTabelaId] = React.useState("");
  const [tabela, setTabela] = React.useState<PrecoDeTabela | null>(null);
  const [descontoTexto, setDescontoTexto] = React.useState("");
  const [descontoPctTexto, setDescontoPctTexto] = React.useState("");
  const [freteTexto, setFreteTexto] = React.useState("");
  const [enviando, setEnviando] = React.useState(false);
  const [aprovacao, setAprovacao] = React.useState(false);
  // Fluxo guiado (§2 Nexus): cliente → produtos → condições → entrega → revisão.
  // O estado do pedido continua único aqui em cima — os passos só decidem o
  // que aparece, nunca duplicam lógica de preço, estoque ou crédito.
  const [passo, setPasso] = React.useState(0);
  const [alcancado, setAlcancado] = React.useState(0);
  const [ultimos, setUltimos] = React.useState<Map<string, UltimoPreco>>(new Map());
  const [historicoItens, setHistoricoItens] = React.useState<
    {
      product_id: string | null;
      produto_nome: string;
      quantidade: number;
      preco_unit_cents: number;
      criado_em: string;
      dias_desde: number;
    }[]
  >([]);

  const porId = React.useMemo(() => new Map(produtos.map((p) => [p.id, p])), [produtos]);

  // Tabela aplicada: desconto + overrides (para o preço efetivo da busca).
  React.useEffect(() => {
    if (!tabelaId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTabela(null);
      return;
    }
    let vivo = true;
    apiClient
      .get<{ itens: { product_id: string; preco_cents: number | null }[] }>(
        `/api/v1/price-tables/${tabelaId}`,
      )
      .then((d) => {
        if (!vivo) return;
        const tab = tabelas.find((x) => x.id === tabelaId);
        setTabela({
          desconto_pct: Number(tab?.desconto_pct ?? 0),
          overrides: new Map(d.itens.map((i) => [i.product_id, i.preco_cents])),
        });
      })
      .catch((e) => {
        if (vivo) showApiError(e);
      });
    return () => {
      vivo = false;
    };
  }, [tabelaId, tabelas]);

  // Histórico do cliente: últimos preços + base de relacionados/reposição.
  React.useEffect(() => {
    if (!contatoId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setUltimos(new Map());
      setHistoricoItens([]);
      return;
    }
    let vivo = true;
    (async () => {
      try {
        const { data: pedidos } = await apiClient.get<{
          data: { id: string; created_at: string }[];
        }>(`/api/v1/commercial-orders?contact_id=${contatoId}`);
        const recentes = pedidos.slice(0, 3);
        const mapa = new Map<string, UltimoPreco>();
        const itens: typeof historicoItens = [];
        // Date.now aqui (efeito async), não no render: dias desde a compra
        // viajam prontos nos itens, e o memo abaixo é puro.
        const agoraPid = Date.now();
        for (const ped of recentes) {
          const { data: det } = await apiClient.get<{
            data: {
              itens: {
                product_id: string | null;
                produto_nome: string;
                quantidade: number;
                preco_unit_cents: number;
              }[];
            };
          }>(`/api/v1/commercial-orders/${ped.id}`);
          for (const item of det.itens) {
            if (item.product_id && !mapa.has(item.product_id)) {
              mapa.set(item.product_id, { preco_cents: item.preco_unit_cents, em: ped.created_at });
            }
            itens.push({
              ...item,
              criado_em: ped.created_at,
              dias_desde: Math.floor((agoraPid - new Date(ped.created_at).getTime()) / 86400000),
            });
          }
        }
        if (vivo) {
          setUltimos(mapa);
          setHistoricoItens(itens);
        }
      } catch (e) {
        if (vivo) showApiError(e);
      }
    })();
    return () => {
      vivo = false;
    };
  }, [contatoId]);

  // Endereço de entrega: ao escolher o cliente, sugere o endereço dele
  // quando o campo está vazio (regra do Mercos: "endereço principal do
  // cliente"). Uma chance por cliente (ref) + set funcional (vale o estado
  // mais novo): digitação e restauração do rascunho nunca são atropeladas.
  const sugeridoPara = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!contatoId || contatoId === sugeridoPara.current || endereco.trim()) return;
    sugeridoPara.current = contatoId;
    let vivo = true;
    (async () => {
      try {
        const { data: c } = await apiClient.get<{
          data: {
            logradouro: string | null;
            numero_end: string | null;
            complemento: string | null;
            bairro: string | null;
            cidade: string | null;
            uf: string | null;
            cep: string | null;
          };
        }>(`/api/v1/contacts/${contatoId}`);
        const linha = enderecoEmLinha(c);
        if (vivo && linha) setEndereco((atual) => (atual.trim() ? atual : linha));
      } catch {
        // Cortesia: o campo continua editável à mão.
      }
    })();
    return () => {
      vivo = false;
    };
  }, [contatoId, endereco]);

  // Autosave (§31).
  const { salvoEm, carregar, limpar } = useAutosaveDraft(
    "pedido-rascunho",
    {
      contatoId,
      clienteNome,
      linhas,
      condicao,
      observacoes,
      obsInterna,
      endereco,
      transportadora,
      tabelaId,
      descontoTexto,
      descontoPctTexto,
      freteTexto,
    },
    true,
  );
  // Restauração única do autosave (montagem): sem ela, fechar o navegador
  // no meio da venda perde tudo (§31).
  /* eslint-disable react-hooks/set-state-in-effect */
  React.useEffect(() => {
    const salvo = carregar();
    if (
      salvo &&
      Array.isArray(salvo.linhas) &&
      (salvo.linhas as unknown[]).length > 0 &&
      linhas.length === 0
    ) {
      const s = salvo as unknown as {
        contatoId: string | null;
        clienteNome: string;
        linhas: LinhaDoPedido[];
        condicao: string;
        observacoes: string;
      };
      setContatoId(s.contatoId);
      setClienteNome(s.clienteNome);
      setLinhas(s.linhas);
      setCondicao(s.condicao ?? "");
      setObservacoes(s.observacoes ?? "");
      nexusToast.info(textos.rascunhoRestaurado);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  function adicionar(produto: Produto, quantidade: number) {
    setLinhas((ls) => {
      // Sem nova linha para o mesmo produto: incrementa (§8).
      const i = ls.findIndex((l) => l.product_id === produto.id);
      if (i >= 0) {
        const copia = [...ls];
        copia[i] = { ...copia[i]!, quantidade: copia[i]!.quantidade + quantidade };
        return copia;
      }
      return [
        ...ls,
        {
          key: `${produto.id}-${Date.now()}`,
          product_id: produto.id,
          codigo: produto.codigo,
          nome: produto.nome,
          quantidade,
          permite_fracao: false,
          precoTexto: (produto.preco_cents / 100).toLocaleString("pt-BR", {
            minimumFractionDigits: 2,
          }),
          descontoPct: 0,
          estoque: produto.controla_estoque ? produto.quantidade : null,
        },
      ];
    });
  }

  function mudarLinha(key: string, patch: Partial<LinhaDoPedido>) {
    setLinhas((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  // Totais calculados AQUI para exibição; o servidor recalcula no POST.
  const subtotal = linhas.reduce((s, l) => {
    const unit = precoParaCentavos(l.precoTexto) ?? 0;
    return s + subtotalDoItem(l.quantidade, unit, l.descontoPct);
  }, 0);
  const descontoCents = descontoTexto.trim() === "" ? 0 : (precoParaCentavos(descontoTexto) ?? 0);
  const descontoPct = Math.min(100, Math.max(0, Number(descontoPctTexto) || 0));
  const descontoPctCents = Math.round((subtotal * descontoPct) / 100);
  const freteCents = freteTexto.trim() === "" ? 0 : (precoParaCentavos(freteTexto) ?? 0);
  const total = subtotal - descontoCents - descontoPctCents + freteCents;
  const qtdUnidades = linhas.reduce((s, l) => s + l.quantidade, 0);

  const margemPct = React.useMemo(() => {
    if (!verMargem || linhas.length === 0) return null;
    let custo = 0;
    for (const l of linhas) {
      const p = porId.get(l.product_id);
      if (p?.custo_cents === null || p?.custo_cents === undefined) return null;
      custo += p.custo_cents * l.quantidade;
    }
    if (total <= 0) return null;
    return Math.round(((total - custo) / total) * 1000) / 10;
  }, [linhas, porId, verMargem, total]);

  const comissaoCents =
    comissaoPct !== null && total > 0 ? Math.round((total * comissaoPct) / 100) : null;

  // Relacionados: mesma categoria, fora do pedido (§18).
  const noPedido = new Set(linhas.map((l) => l.product_id));
  const relacionados = React.useMemo(() => {
    const cats = new Set(
      linhas.map((l) => porId.get(l.product_id)?.categoria).filter(Boolean) as string[],
    );
    if (cats.size === 0) return [];
    return produtos
      .filter((p) => p.categoria && cats.has(p.categoria) && !noPedido.has(p.id))
      .slice(0, 5);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linhas, produtos]);

  // Reposição: compra repetida em intervalo regular, já na hora (§21).
  const reposicoes = React.useMemo(() => {
    const porProd = new Map<
      string,
      { qtds: number[]; datas: number[]; dias: number[]; nome: string; id: string }
    >();
    for (const h of historicoItens) {
      if (!h.product_id || noPedido.has(h.product_id)) continue;
      const e = porProd.get(h.product_id) ?? {
        qtds: [],
        datas: [],
        dias: [],
        nome: h.produto_nome,
        id: h.product_id,
      };
      e.qtds.push(h.quantidade);
      e.datas.push(new Date(h.criado_em).getTime());
      e.dias.push(h.dias_desde);
      porProd.set(h.product_id, e);
    }
    const out: { id: string; nome: string; qtd: number; dias: number }[] = [];
    for (const e of porProd.values()) {
      if (e.datas.length < 2) continue;
      const ord = [...e.datas].sort((a, b) => a - b);
      const intervalos: number[] = [];
      for (let i = 1; i < ord.length; i++) intervalos.push((ord[i]! - ord[i - 1]!) / 86400000);
      const medio = intervalos.reduce((s, v) => s + v, 0) / intervalos.length;
      const desdeUltima = Math.min(...e.dias);
      if (medio >= 7 && desdeUltima >= medio * 0.8) {
        const qtdMedia = Math.round(e.qtds.reduce((s, v) => s + v, 0) / e.qtds.length);
        out.push({ id: e.id, nome: e.nome, qtd: qtdMedia, dias: desdeUltima });
      }
    }
    return out.slice(0, 3);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historicoItens]);

  async function enviar(status: "rascunho" | "aprovado") {
    if (!clienteNome.trim()) {
      nexusToast.error(t("Escolha ou digite o nome do cliente."));
      setPasso(0);
      return;
    }
    if (linhas.length === 0) {
      nexusToast.error(t("Adicione ao menos 1 produto."));
      setPasso(1);
      return;
    }
    const itens = [];
    for (const l of linhas) {
      const unit = precoParaCentavos(l.precoTexto);
      if (unit === null) {
        nexusToast.error(`${t("Preço inválido em")} "${l.nome}". ${t("Escreva assim: 5.499,00")}`);
        setPasso(1);
        return;
      }
      itens.push({
        product_id: l.product_id,
        quantidade: l.quantidade,
        preco_unit_cents: unit,
        desconto_pct: l.descontoPct,
      });
    }
    try {
      const { data: pedido } = await apiClient.post<{
        data: { id: string; numero: number; aprovacao_necessaria?: boolean };
      }>(`/api/v1/commercial-orders`, {
        contact_id: contatoId,
        cliente_nome: clienteNome.trim(),
        status,
        origem: "vendedor",
        desconto_cents: descontoCents,
        ...(descontoPct > 0 ? { desconto_pct: descontoPct } : {}),
        ...(tabelaId ? { price_table_id: tabelaId } : {}),
        frete_cents: freteCents,
        ...(condicao.trim() ? { condicao_pagamento: condicao.trim() } : {}),
        ...(observacoes.trim() ? { observacoes: observacoes.trim() } : {}),
        ...(obsInterna.trim() ? { obs_interna: obsInterna.trim() } : {}),
        ...(endereco.trim() ? { endereco_entrega: endereco.trim() } : {}),
        ...(transportadora.trim() ? { transportadora_nome: transportadora.trim() } : {}),
        itens,
      });
      if (pedido.aprovacao_necessaria) setAprovacao(true);
      nexusToast.success(`${textos.pedidoCriado}: PED-${String(pedido.numero).padStart(4, "0")}`);
      limpar();
      router.push("/app/pedidos");
    } catch (e) {
      showApiError(e);
    }
  }

  useOrderShortcuts({
    focarBusca: () => buscaRef.current?.focus(),
    finalizar: () => void enviar("aprovado"),
    desfocar: () => (document.activeElement as HTMLElement | null)?.blur(),
  });

  async function comEnvio(status: "rascunho" | "aprovado") {
    setEnviando(true);
    try {
      await enviar(status);
    } finally {
      setEnviando(false);
    }
  }

  const PASSOS = [t("Cliente"), t("Produtos"), t("Condições"), t("Entrega"), t("Revisão")];

  function continuar() {
    if (passo === 0 && !clienteNome.trim()) {
      nexusToast.error(t("Escolha ou digite o nome do cliente."));
      return;
    }
    if (passo === 1 && linhas.length === 0) {
      nexusToast.error(t("Adicione ao menos 1 produto."));
      return;
    }
    const prox = Math.min(PASSOS.length - 1, passo + 1);
    setPasso(prox);
    setAlcancado((a) => Math.max(a, prox));
  }

  function voltar() {
    setPasso((p) => Math.max(0, p - 1));
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-6 pb-24 lg:pb-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-medium tracking-tight text-text">{textos.titulo}</h1>
          <p className="text-sm text-muted-foreground">
            {textos.subtitulo}
            {linhas.length > 0 && salvoEm && (
              <>
                {" "}
                · {t("salvo")} {haQuantoTempo(salvoEm) ?? ""}
              </>
            )}
          </p>
        </div>
      </div>

      <NexusSteps steps={PASSOS} current={passo} reached={alcancado} onGo={(i) => setPasso(i)} />

      {passo === 0 && (
        <section aria-label={PASSOS[0]} className="min-w-0 space-y-4">
          <CustomerSelector
            contatos={contatos}
            contatoId={contatoId}
            clienteNome={clienteNome}
            aoEscolher={(id, nome) => {
              setContatoId(id);
              setClienteNome(nome);
            }}
            textos={{
              cliente: textos.cliente,
              buscarCliente: textos.buscarCliente,
              clienteAvulso: textos.clienteAvulso,
            }}
          />
        </section>
      )}

      {passo === 1 && (
        <section aria-label={PASSOS[1]} className="min-w-0 space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="tabela">{textos.tabelaPreco}</Label>
            <Select
              value={tabelaId || "__nenhuma"}
              onValueChange={(v) => setTabelaId(v === "__nenhuma" ? "" : v)}
            >
              <SelectTrigger id="tabela" className="w-full">
                <SelectValue placeholder={textos.semTabela} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__nenhuma">{textos.semTabela}</SelectItem>
                {tabelas.map((tb) => (
                  <SelectItem key={tb.id} value={tb.id}>
                    {tb.nome}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <ProductSearch
            produtos={produtos}
            tabela={tabela}
            ultimosPrecos={ultimos}
            inputRef={buscaRef}
            aoAdicionar={(p, q) => {
              const prod = porId.get(p.id);
              if (prod) adicionar(prod, q);
            }}
            textos={{ produtos: textos.produtos, buscarProduto: textos.buscarProduto }}
          />

          <OrderItems
            linhas={linhas}
            aoMudar={mudarLinha}
            aoRemover={(k) => setLinhas((ls) => ls.filter((l) => l.key !== k))}
          />

          {relacionados.length > 0 && (
            <div className="rounded-2xl border p-3">
              <p className="mb-2 text-sm font-medium">{textos.relacionados}</p>
              <div className="flex flex-wrap gap-2">
                {relacionados.map((p) => (
                  <Button key={p.id} size="sm" variant="outline" onClick={() => adicionar(p, 1)}>
                    + {p.nome}
                  </Button>
                ))}
              </div>
            </div>
          )}

          {reposicoes.map((r) => (
            <div
              key={r.id}
              className="flex items-center justify-between gap-2 rounded-2xl border p-3 text-sm"
            >
              <p>
                💡 {r.nome} · {r.qtd} un · {t("a cada")} ~{r.dias} {t("dias")}? ({t("há")} {r.dias}{" "}
                {t("dias")})
              </p>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  const p = porId.get(r.id);
                  if (p) adicionar(p, r.qtd);
                }}
              >
                {textos.adicionar}
              </Button>
            </div>
          ))}

          {historicoItens.length > 0 && (
            <details className="rounded-2xl border p-3 text-sm">
              <summary className="cursor-pointer font-medium">{textos.historico}</summary>
              <ul className="mt-2 space-y-1 text-muted-foreground">
                {historicoItens.slice(0, 8).map((h, i) => (
                  <li key={i}>
                    {h.produto_nome} · {h.quantidade} un
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
      )}

      {passo === 2 && (
        <section aria-label={PASSOS[2]} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="condicao">{textos.condicao}</Label>
            <Input
              id="condicao"
              value={condicao}
              onChange={(e) => setCondicao(e.target.value)}
              placeholder="30/60/90 dias"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="desconto">{`${textos.desconto} (R$)`}</Label>
            <Input
              id="desconto"
              value={descontoTexto}
              onChange={(e) => setDescontoTexto(e.target.value)}
              placeholder="0,00"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="desconto-pct">{`${textos.desconto} (%)`}</Label>
            <Input
              id="desconto-pct"
              type="number"
              min={0}
              max={100}
              value={descontoPctTexto}
              onChange={(e) => setDescontoPctTexto(e.target.value)}
              placeholder="0"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="frete">{`${textos.frete} (R$)`}</Label>
            <Input
              id="frete"
              value={freteTexto}
              onChange={(e) => setFreteTexto(e.target.value)}
              placeholder="0,00"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="obs">{textos.observacoes}</Label>
            <Input id="obs" value={observacoes} onChange={(e) => setObservacoes(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="obs-interna">{textos.obsInterna}</Label>
            <Input
              id="obs-interna"
              value={obsInterna}
              onChange={(e) => setObsInterna(e.target.value)}
            />
          </div>
        </section>
      )}

      {passo === 3 && (
        <section aria-label={PASSOS[3]} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="transportadora">{textos.transportadora}</Label>
            <Input
              id="transportadora"
              value={transportadora}
              onChange={(e) => setTransportadora(e.target.value)}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="endereco">{textos.endereco}</Label>
            <Input
              id="endereco"
              value={endereco}
              onChange={(e) => setEndereco(e.target.value)}
              placeholder={textos.enderecoExemplo}
            />
          </div>
        </section>
      )}

      {passo === 4 && (
        <section aria-label={PASSOS[4]} className="min-w-0 space-y-4">
          <div className="rounded-2xl border p-4 text-sm">
            <p>
              <span className="text-muted-foreground">{t("Cliente")}: </span>
              <strong>{clienteNome || "—"}</strong>
            </p>
            <p className="mt-1">
              <span className="text-muted-foreground">{t("Itens")}: </span>
              <strong className="tabular-nums">
                {linhas.length} · {qtdUnidades} un · {comoMoeda(total, "BRL")}
              </strong>
            </p>
            {condicao.trim() && (
              <p className="mt-1">
                <span className="text-muted-foreground">{textos.condicao}: </span>
                <strong>{condicao.trim()}</strong>
              </p>
            )}
            {(transportadora.trim() || endereco.trim()) && (
              <p className="mt-1">
                <span className="text-muted-foreground">
                  {textos.transportadora}/{textos.endereco}:{" "}
                </span>
                <strong>
                  {[transportadora.trim(), endereco.trim()].filter(Boolean).join(" · ")}
                </strong>
              </p>
            )}
          </div>
          <OrderSummary
            totais={{
              subtotal,
              descontoCents: descontoCents + descontoPctCents,
              freteCents,
              total,
              qtdItens: linhas.length,
              qtdUnidades,
              margemPct,
              comissaoCents,
              parcelas: calcularParcelas(total, condicao),
              aprovacaoNecessaria: aprovacao,
            }}
            descontoTexto={descontoTexto}
            aoDesconto={setDescontoTexto}
            descontoPctTexto={descontoPctTexto}
            aoDescontoPct={setDescontoPctTexto}
            freteTexto={freteTexto}
            aoFrete={setFreteTexto}
            enviando={enviando}
            aoSalvar={() => void comEnvio("rascunho")}
            aoFinalizar={() => void comEnvio("aprovado")}
            textos={{
              subtotal: textos.subtotal,
              desconto: textos.desconto,
              frete: textos.frete,
              total: textos.total,
              salvarRascunho: textos.salvarRascunho,
              finalizar: textos.finalizar,
              margem: textos.margem,
              comissao: textos.comissao,
              aguardandoAprovacao: textos.aguardandoAprovacao,
              revisar: textos.revisar,
              itensUnidades: (itens, un) => `${itens} itens · ${un} un`,
            }}
          />
        </section>
      )}

      {passo < PASSOS.length - 1 && (
        <div className="flex items-center justify-between gap-3">
          {passo > 0 ? (
            <Button variant="outline" onClick={voltar}>
              {t("Voltar")}
            </Button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-3">
            {passo === 1 && linhas.length > 0 && (
              <p className="text-sm text-muted-foreground tabular-nums">
                {linhas.length} {t("itens")} · {comoMoeda(total, "BRL")}
              </p>
            )}
            <Button onClick={continuar}>{t("Continuar")}</Button>
          </div>
        </div>
      )}
    </div>
  );
}
