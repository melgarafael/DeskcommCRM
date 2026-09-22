/**
 * O PEDIDO EM PDF — documento comercial para impressão e envio.
 *
 * Renderizado para Buffer via @react-pdf/renderer pela rota
 * `GET /api/v1/commercial-orders/[id]/pdf`.
 *
 * O conteúdo espelha a impressão do Mercos (medida no arquivo "Imprimir
 * pedidos 12.pdf" da Bill, nov/2025): cabeçalho da empresa + número,
 * representada, bloco completo do cliente (fantasia, CPF/CNPJ, IE, endereço,
 * bairro, CEP, cidade/UF, fone, e-mail), grade de itens (#, código, produto,
 * qtde, unidade, desconto, preço líquido, subtotal), total, condição,
 * emissão, vendedor e informações adicionais. O desenho é próprio (faixa
 * marinho, cartão do cliente em 2 colunas, tabela zebrada) — só os DADOS
 * seguem o modelo deles.
 *
 * O que o nosso modelo NÃO tem não é inventado: "Qtde. volumes" do Mercos é
 * contagem de embalagens deles e não existe em `commercial_order_items`, por
 * isso não aparece. Unidade do item vem de `catalog_products.unidade`
 * (padrão "UN").
 *
 * Identidade: o EMITENTE é a loja (`organizations.display_name/legal_name` +
 * CNPJ) — nunca a marca do software (doutrina white-label: `branding.test.ts`
 * reprova "Deskcomm" em código que alcança o usuário). Este documento não
 * leva marca nenhuma do produto, só os dados do negócio.
 */
import { Document, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import React from "react";

import { ROTULO_DO_STATUS, type StatusDoPedido } from "@/lib/schemas/pedidos";

const MARINHO = "#1e3a5f";
const CINZA = "#6b7280";
const BORDA = "#e5e7eb";
const FUNDO = "#f3f4f6";

const styles = StyleSheet.create({
  page: { padding: 36, fontSize: 10, fontFamily: "Helvetica", color: "#1f2937" },
  faixa: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
    borderBottom: `2pt solid ${MARINHO}`,
    paddingBottom: 10,
    marginBottom: 4,
  },
  emitente: { fontSize: 15, fontWeight: "bold", color: MARINHO },
  emitenteDoc: { fontSize: 9, color: CINZA, marginTop: 2 },
  numero: { fontSize: 17, fontWeight: "bold", color: MARINHO, textAlign: "right" },
  statusLinha: { fontSize: 9, color: CINZA, marginTop: 2, textAlign: "right" },
  representada: { fontSize: 9, color: CINZA, marginBottom: 12 },
  cartao: { border: `0.5pt solid ${BORDA}`, borderRadius: 4, marginBottom: 12 },
  cartaoTitulo: {
    fontSize: 10,
    fontWeight: "bold",
    color: MARINHO,
    backgroundColor: FUNDO,
    paddingVertical: 5,
    paddingHorizontal: 8,
  },
  cartaoCorpo: { flexDirection: "row", padding: 8, gap: 12 },
  coluna: { flex: 1 },
  campo: { marginBottom: 4 },
  campoRotulo: { fontSize: 8, color: CINZA, textTransform: "uppercase" },
  campoValor: { fontSize: 10 },
  tabelaCab: {
    flexDirection: "row",
    backgroundColor: MARINHO,
    color: "#ffffff",
    fontSize: 9,
    fontWeight: "bold",
    paddingVertical: 6,
    paddingHorizontal: 4,
  },
  tabelaLinha: { flexDirection: "row", fontSize: 9, paddingVertical: 5, paddingHorizontal: 4 },
  zebra: { backgroundColor: "#f9fafb" },
  colNum: { width: "5%" },
  colCod: { width: "11%" },
  colDesc: { width: "32%" },
  colQtd: { width: "8%", textAlign: "right" },
  colUn: { width: "7%", textAlign: "center" },
  colDesc2: { width: "8%", textAlign: "right" },
  colPreco: { width: "14%", textAlign: "right" },
  colTotal: { width: "15%", textAlign: "right" },
  rodapeTabela: { flexDirection: "row", justifyContent: "flex-end", marginTop: 8 },
  totais: { width: "42%" },
  totalLinha: { flexDirection: "row", justifyContent: "space-between", marginBottom: 2, fontSize: 10 },
  totalGeral: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 4,
    paddingTop: 5,
    borderTop: `1pt solid ${MARINHO}`,
    fontSize: 13,
    fontWeight: "bold",
    color: MARINHO,
  },
  meta: { flexDirection: "row", gap: 16, marginTop: 12, marginBottom: 4 },
  metaItem: { flex: 1 },
  obs: { marginTop: 8, fontSize: 9, color: "#4b5563", border: `0.5pt solid ${BORDA}`, borderRadius: 4, padding: 8 },
  rodape: {
    position: "absolute",
    bottom: 24,
    left: 36,
    right: 36,
    fontSize: 8,
    color: "#9ca3af",
    borderTop: `0.5pt solid ${BORDA}`,
    paddingTop: 4,
    flexDirection: "row",
    justifyContent: "space-between",
  },
});

export interface PedidoPdfEmitente {
  nome: string;
  documento: string | null;
}

/** Bloco do cliente — os mesmos campos da impressão do Mercos. */
export interface PedidoPdfCliente {
  nome: string;
  fantasia: string | null;
  /** "CPF" ou "CNPJ" conforme o tipo da pessoa. */
  rotuloDocumento: string;
  documento: string | null;
  ie: string | null;
  endereco: string | null;
  bairro: string | null;
  cep: string | null;
  cidade: string | null;
  uf: string | null;
  fone: string | null;
  email: string | null;
}

export interface PedidoPdfItem {
  produto_codigo: string;
  produto_nome: string;
  quantidade: number;
  unidade: string;
  preco_unit_cents: number;
  desconto_pct: number;
  subtotal_cents: number;
}

export interface PedidoPdfDados {
  numero: number;
  status: StatusDoPedido;
  subtotal_cents: number;
  desconto_cents: number;
  frete_cents: number;
  total_cents: number;
  condicao_pagamento: string | null;
  observacoes: string | null;
  endereco_entrega: string | null;
  created_at: string;
  cliente: PedidoPdfCliente;
  vendedor_nome: string | null;
  itens: PedidoPdfItem[];
}

function moeda(cents: number): string {
  return `R$ ${(cents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`;
}

function dataFmt(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
}

/**
 * Preço líquido do item: tabela × (1 − desconto). Mesmo arredondamento do
 * `subtotalDoItem` (round, não truncamento) para o impresso bater com a tela.
 */
export function precoLiquidoCents(precoUnitCents: number, descontoPct: number): number {
  return Math.round(precoUnitCents * (1 - Number(descontoPct ?? 0) / 100));
}

export function numeroDoPedidoPdf(numero: number): string {
  return `PED-${String(numero).padStart(4, "0")}`;
}

function Campo({ rotulo, valor }: { rotulo: string; valor: string | null }) {
  return (
    <View style={styles.campo}>
      <Text style={styles.campoRotulo}>{rotulo}</Text>
      <Text style={styles.campoValor}>{valor?.trim() ? valor : "—"}</Text>
    </View>
  );
}

export function PedidoPdf({
  emitente,
  pedido,
}: {
  emitente: PedidoPdfEmitente;
  pedido: PedidoPdfDados;
}) {
  const c = pedido.cliente;
  const cidadeUf = [c.cidade, c.uf].filter(Boolean).join("/");
  const entregaDiferente =
    pedido.endereco_entrega?.trim() &&
    c.endereco &&
    pedido.endereco_entrega.trim().toLowerCase() !== c.endereco.trim().toLowerCase()
      ? pedido.endereco_entrega.trim()
      : null;
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.faixa}>
          <View>
            <Text style={styles.emitente}>{emitente.nome}</Text>
            {emitente.documento && <Text style={styles.emitenteDoc}>CNPJ: {emitente.documento}</Text>}
          </View>
          <View>
            <Text style={styles.numero}>Pedido Nº {pedido.numero}</Text>
            <Text style={styles.statusLinha}>
              {ROTULO_DO_STATUS[pedido.status] ?? pedido.status} · {dataFmt(pedido.created_at)}
            </Text>
          </View>
        </View>
        <Text style={styles.representada}>
          Representada: {emitente.nome}
          {pedido.vendedor_nome ? ` / ${emitente.nome} - ${pedido.vendedor_nome}` : ""}
          {emitente.documento ? ` · CNPJ: ${emitente.documento}` : ""}
        </Text>

        <View style={styles.cartao}>
          <Text style={styles.cartaoTitulo}>Cliente</Text>
          <View style={styles.cartaoCorpo}>
            <View style={styles.coluna}>
              <Campo rotulo="Cliente" valor={c.nome} />
              <Campo rotulo="Nome fantasia" valor={c.fantasia} />
              <Campo rotulo={c.rotuloDocumento} valor={c.documento} />
              <Campo rotulo="Inscrição estadual" valor={c.ie} />
              <Campo rotulo="Telefone" valor={c.fone} />
              <Campo rotulo="E-mail" valor={c.email} />
            </View>
            <View style={styles.coluna}>
              <Campo rotulo="Endereço" valor={c.endereco} />
              <Campo rotulo="Bairro" valor={c.bairro} />
              <Campo rotulo="CEP" valor={c.cep} />
              <Campo rotulo="Cidade / Estado" valor={cidadeUf || null} />
              {entregaDiferente && <Campo rotulo="Entrega" valor={entregaDiferente} />}
            </View>
          </View>
        </View>

        <View style={styles.tabelaCab}>
          <Text style={styles.colNum}>#</Text>
          <Text style={styles.colCod}>Código</Text>
          <Text style={styles.colDesc}>Produto</Text>
          <Text style={styles.colQtd}>Qtde.</Text>
          <Text style={styles.colUn}>Un.</Text>
          <Text style={styles.colDesc2}>Desc.</Text>
          <Text style={styles.colPreco}>Preço líq.</Text>
          <Text style={styles.colTotal}>Subtotal</Text>
        </View>
        {pedido.itens.map((item, i) => (
          <View key={i} style={[styles.tabelaLinha, i % 2 === 1 ? styles.zebra : undefined]}>
            <Text style={styles.colNum}>{i + 1}</Text>
            <Text style={styles.colCod}>{item.produto_codigo || "—"}</Text>
            <Text style={styles.colDesc}>{item.produto_nome}</Text>
            <Text style={styles.colQtd}>{item.quantidade}</Text>
            <Text style={styles.colUn}>{item.unidade || "UN"}</Text>
            <Text style={styles.colDesc2}>{Number(item.desconto_pct) > 0 ? `${Number(item.desconto_pct)}%` : "—"}</Text>
            <Text style={styles.colPreco}>{moeda(precoLiquidoCents(item.preco_unit_cents, item.desconto_pct))}</Text>
            <Text style={styles.colTotal}>{moeda(item.subtotal_cents)}</Text>
          </View>
        ))}

        <View style={styles.rodapeTabela}>
          <View style={styles.totais}>
            <View style={styles.totalLinha}>
              <Text>Subtotal</Text>
              <Text>{moeda(pedido.subtotal_cents)}</Text>
            </View>
            {pedido.desconto_cents > 0 && (
              <View style={styles.totalLinha}>
                <Text>Descontos</Text>
                <Text>{moeda(pedido.desconto_cents)}</Text>
              </View>
            )}
            {pedido.frete_cents > 0 && (
              <View style={styles.totalLinha}>
                <Text>Frete</Text>
                <Text>{moeda(pedido.frete_cents)}</Text>
              </View>
            )}
            <View style={styles.totalGeral}>
              <Text>Valor total</Text>
              <Text>{moeda(pedido.total_cents)}</Text>
            </View>
          </View>
        </View>

        <View style={styles.meta}>
          <View style={styles.metaItem}>
            <Campo rotulo="Condição de pagamento" valor={pedido.condicao_pagamento} />
          </View>
          <View style={styles.metaItem}>
            <Campo rotulo="Data de emissão" valor={dataFmt(pedido.created_at)} />
          </View>
          <View style={styles.metaItem}>
            <Campo rotulo="Vendedor" valor={pedido.vendedor_nome} />
          </View>
        </View>

        {pedido.observacoes?.trim() && (
          <View style={styles.obs}>
            <Text>Informações adicionais: {pedido.observacoes.trim()}</Text>
          </View>
        )}

        <View style={styles.rodape} fixed>
          <Text>
            {emitente.nome}
            {emitente.documento ? ` · ${emitente.documento}` : ""}
          </Text>
          <Text render={({ pageNumber }: { pageNumber: number }) => `Página ${pageNumber}`} />
        </View>
      </Page>
    </Document>
  );
}

export async function renderPedidoPdf(
  emitente: PedidoPdfEmitente,
  pedido: PedidoPdfDados,
): Promise<Buffer> {
  const buf = await renderToBuffer(<PedidoPdf emitente={emitente} pedido={pedido} />);
  return buf as Buffer;
}
