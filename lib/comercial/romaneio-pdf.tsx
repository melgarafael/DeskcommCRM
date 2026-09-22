/**
 * O ROMANEIO DE CARGA EM PDF — o papel que viaja com o motorista.
 *
 * Pedidos em ordem de sequência, com endereço de entrega e espaço para
 * assinatura. Antes da separação por pedido, o RESUMO DE SEPARAÇÃO agrega
 * os itens repetidos (o mesmo produto em 2+ pedidos): quem separa pega as
 * 2 estopas de uma vez em vez de voltar buscar depois. Mesma doutrina do
 * PDF de pedido: identidade da loja, nunca do software.
 */
import { Document, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import React from "react";

import { numeroDaCarga } from "@/lib/schemas/expedicao";
import { ConteudoFechamento, type FechamentoCarga } from "./fechamento-expedicao-pdf";

const styles = StyleSheet.create({
  page: { padding: 36, fontSize: 10, fontFamily: "Helvetica", color: "#1f2937" },
  header: { borderBottom: "2pt solid #1e3a5f", paddingBottom: 10, marginBottom: 14 },
  emitente: { fontSize: 14, fontWeight: "bold", color: "#1e3a5f" },
  tituloLinha: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
    marginBottom: 12,
  },
  numero: { fontSize: 16, fontWeight: "bold" },
  info: { fontSize: 10, color: "#4b5563" },
  linha: { flexDirection: "row", marginBottom: 2 },
  rotulo: { width: 110, color: "#6b7280" },
  valor: { flex: 1 },
  tabelaCab: {
    flexDirection: "row",
    backgroundColor: "#1e3a5f",
    color: "#ffffff",
    fontSize: 9,
    fontWeight: "bold",
    padding: 5,
  },
  tabelaLinha: { fontSize: 9, padding: 6, borderBottom: "0.5pt solid #e5e7eb" },
  seqLinha: { flexDirection: "row", marginBottom: 3 },
  seqNum: { width: 28, fontSize: 14, fontWeight: "bold", color: "#1e3a5f" },
  seqCorpo: { flex: 1 },
  endereco: { fontSize: 9, color: "#4b5563", marginTop: 2 },
  checkTitulo: { fontSize: 9, fontWeight: "bold", marginTop: 6, marginBottom: 3 },
  checkLegenda: { fontSize: 7, color: "#6b7280", marginBottom: 3 },
  checkLinha: { flexDirection: "row", marginBottom: 2, fontSize: 9 },
  checkBox: { width: 20 },
  checkQtd: { width: 64 },
  checkNome: { flex: 1 },
  separacao: {
    border: "1pt solid #1e3a5f",
    borderRadius: 4,
    padding: 8,
    marginTop: 8,
    marginBottom: 10,
  },
  blocoTitulo: { fontSize: 11, fontWeight: "bold", color: "#1e3a5f", marginBottom: 2 },
  sepQtd: { width: 56, fontWeight: "bold" },
  sepPedidos: { fontSize: 8, color: "#6b7280", marginLeft: 6 },
  assinatura: {
    marginTop: 8,
    paddingTop: 18,
    borderTop: "0.5pt solid #9ca3af",
    width: "60%",
    fontSize: 8,
    color: "#6b7280",
  },
  rodape: {
    position: "absolute",
    bottom: 24,
    left: 36,
    right: 36,
    fontSize: 8,
    color: "#9ca3af",
    borderTop: "0.5pt solid #e5e7eb",
    paddingTop: 4,
    flexDirection: "row",
    justifyContent: "space-between",
  },
});

export interface ItemDaParada {
  codigo: string;
  nome: string;
  quantidade: number;
}

export interface ParadaDoRomaneio {
  sequencia: number;
  numero: number;
  cliente_nome: string;
  endereco_entrega: string | null;
  total_cents: number;
  status: string;
  /** Itens do pedido para o checklist de carregamento (opcional p/ compat). */
  itens?: ItemDaParada[];
}

export interface RomaneioDados {
  numero: number;
  placa: string | null;
  veiculo_tipo: string | null;
  motorista_nome: string | null;
  paradas: ParadaDoRomaneio[];
}

function moeda(cents: number): string {
  return `R$ ${(cents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`;
}

/**
 * Ordem de entrega: sequência da rota, desempate pelo número. A rota SQL já
 * vem ordenada, mas o romaneio não confia nisso — quem IMPRIME garante a
 * ordem que o motorista dirige.
 */
export function ordenarParadasDoRomaneio(paradas: ParadaDoRomaneio[]): ParadaDoRomaneio[] {
  return [...paradas].sort((a, b) => a.sequencia - b.sequencia || a.numero - b.numero);
}

export interface ItemRepetido {
  codigo: string;
  nome: string;
  quantidade_total: number;
  /** PEDs que pediram (para conferir na separação por pedido abaixo). */
  pedidos: number[];
}

/**
 * Itens repetidos na carga: mesmo produto em 2+ pedidos, com a soma para
 * separar de uma vez. Chave = código; sem código, o nome normalizado
 * (caixa/espaço — "ESTOPA 20KG" e "estopa  20kg" são a mesma estopa).
 * Ordem: maior quantidade primeiro (o que mais pesa na separação).
 */
export function agruparItensRepetidos(paradas: ParadaDoRomaneio[]): ItemRepetido[] {
  const norm = (nome: string): string =>
    nome.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/\s+/g, " ").trim();
  interface Grupo extends ItemRepetido {
    nomeNorm: string;
    pedidosSet: Set<number>;
  }
  const porCodigo = new Map<string, Grupo>();
  const semCodigo: Grupo[] = [];
  const novo = (codigo: string, nome: string): Grupo => ({
    codigo: codigo.trim(),
    nome: nome.trim(),
    nomeNorm: norm(nome),
    quantidade_total: 0,
    pedidos: [],
    pedidosSet: new Set(),
  });
  for (const p of paradas) {
    for (const it of p.itens ?? []) {
      const codigo = it.codigo.trim();
      if (codigo) {
        let g = porCodigo.get(codigo);
        if (!g) {
          g = novo(codigo, it.nome);
          porCodigo.set(codigo, g);
        }
        g.quantidade_total += it.quantidade;
        g.pedidosSet.add(p.numero);
      } else {
        const nomeNorm = norm(it.nome);
        if (!nomeNorm) continue;
        let g = semCodigo.find((x) => x.nomeNorm === nomeNorm);
        if (!g) {
          g = novo("", it.nome);
          semCodigo.push(g);
        }
        g.quantidade_total += it.quantidade;
        g.pedidosSet.add(p.numero);
      }
    }
  }
  // Sem código que é o mesmo produto de um com código ("estopa 20kg" =
  // "114/ESTOPA 20KG"): dobra no grupo codificado, mantendo a identidade.
  for (const g of semCodigo) {
    const alvo = [...porCodigo.values()].find((c) => c.nomeNorm === g.nomeNorm);
    if (alvo) {
      alvo.quantidade_total += g.quantidade_total;
      for (const n of g.pedidosSet) alvo.pedidosSet.add(n);
    } else {
      porCodigo.set(`nome:${g.nomeNorm}`, g);
    }
  }
  return [...porCodigo.values()]
    .filter((g) => g.pedidosSet.size > 1)
    .map(({ pedidosSet, nomeNorm: _nomeNorm, ...resto }) => ({
      ...resto,
      pedidos: [...pedidosSet].sort((a, b) => a - b),
    }))
    .sort((a, b) => b.quantidade_total - a.quantidade_total || a.nome.localeCompare(b.nome, "pt-BR"));
}

export function RomaneioPdf({
  emitente,
  carga,
}: {
  emitente: { nome: string };
  carga: RomaneioDados;
}) {
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <ConteudoRomaneio emitente={emitente} carga={carga} />
        <Rodape emitenteNome={emitente.nome} />
      </Page>
    </Document>
  );
}

/**
 * O DOCUMENTO ÚNICO — romaneio na frente, fechamento atrás, mesma folha
 * impressa. O motorista leva um papel só: carrega e entrega pela frente,
 * presta contas pelo verso.
 */
export interface ParadaCompleta extends ParadaDoRomaneio {
  condicao: string | null;
  motivo: string | null;
  entregue_em: string | null;
  pago_cents: number;
}

export interface RomaneioEFechamentoDados extends Omit<RomaneioDados, "paradas"> {
  montada_em: string;
  paradas: ParadaCompleta[];
}

export function RomaneioEFechamentoPdf({
  emitente,
  carga,
  emitidoEm,
}: {
  emitente: { nome: string };
  carga: RomaneioEFechamentoDados;
  emitidoEm: string;
}) {
  const fechamento: FechamentoCarga = {
    numero: carga.numero,
    placa: carga.placa,
    veiculo_tipo: carga.veiculo_tipo,
    motorista_nome: carga.motorista_nome,
    status: "",
    montada_em: carga.montada_em,
    paradas: carga.paradas.map((p) => ({
      sequencia: p.sequencia,
      numero: p.numero,
      cliente_nome: p.cliente_nome,
      endereco_entrega: p.endereco_entrega,
      total_cents: p.total_cents,
      condicao: p.condicao,
      situacao: p.status,
      motivo: p.motivo,
      entregue_em: p.entregue_em,
      volumes: (p.itens ?? []).reduce((s, i) => s + i.quantidade, 0),
      pago_cents: p.pago_cents,
    })),
  };
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <ConteudoRomaneio emitente={emitente} carga={carga} />
        <Rodape emitenteNome={emitente.nome} />
      </Page>
      <Page size="A4" style={styles.page}>
        <ConteudoFechamento carga={fechamento} emitidoEm={emitidoEm} />
        <Rodape emitenteNome={emitente.nome} />
      </Page>
    </Document>
  );
}

function ConteudoRomaneio({
  emitente,
  carga,
}: {
  emitente: { nome: string };
  carga: RomaneioDados;
}) {
  const paradas = ordenarParadasDoRomaneio(carga.paradas);
  const total = paradas.reduce((s, p) => s + p.total_cents, 0);
  const repetidos = agruparItensRepetidos(paradas);
  return (
    <View>
        <View style={styles.header}>
          <Text style={styles.emitente}>{emitente.nome}</Text>
        </View>

        <View style={styles.tituloLinha}>
          <Text style={styles.numero}>Romaneio — {numeroDaCarga(carga.numero)}</Text>
          <Text style={styles.info}>
            {[carga.placa, carga.veiculo_tipo, carga.motorista_nome].filter(Boolean).join(" · ") ||
              "Sem veículo definido"}
          </Text>
        </View>

        <View style={styles.tabelaCab}>
          <Text>Ordem de entrega ({paradas.length} paradas · {moeda(total)})</Text>
        </View>

        {repetidos.length > 0 && (
          <View style={styles.separacao}>
            <Text style={styles.blocoTitulo}>Separação — leve tudo de uma vez</Text>
            <Text style={styles.checkLegenda}>
              Itens que se repetem em mais de um pedido: separe o total agora para não voltar buscar depois.
            </Text>
            {repetidos.map((r, i) => (
              <View key={`${r.codigo}-${r.nome}-${i}`} style={styles.checkLinha}>
                <Text style={styles.checkBox}>[ ]</Text>
                <Text style={styles.sepQtd}>{r.quantidade_total} un.</Text>
                <Text style={styles.checkNome}>
                  {r.codigo ? `${r.codigo} — ` : ""}
                  {r.nome}
                </Text>
                <Text style={styles.sepPedidos}>{r.pedidos.map((n) => `PED-${String(n).padStart(4, "0")}`).join(" · ")}</Text>
              </View>
            ))}
          </View>
        )}

        {paradas.map((p) => {
          const itens = p.itens ?? [];
          const qtdTotal = itens.reduce((s, i) => s + i.quantidade, 0);
          return (
          <View key={`${p.sequencia}-${p.numero}`} style={styles.tabelaLinha} wrap={false}>
            <View style={styles.seqLinha}>
              <Text style={styles.seqNum}>{p.sequencia}</Text>
              <View style={styles.seqCorpo}>
                <View style={styles.linha}>
                  <Text style={styles.rotulo}>Pedido</Text>
                  <Text style={styles.valor}>
                    PED-{String(p.numero).padStart(4, "0")} · {p.cliente_nome} · {moeda(p.total_cents)}
                  </Text>
                </View>
                <Text style={styles.endereco}>{p.endereco_entrega ?? "Endereço não informado"}</Text>
                {itens.length > 0 && (
                  <View>
                    <Text style={styles.checkTitulo}>
                      Checklist — {itens.length} {itens.length === 1 ? "item" : "itens"} · {qtdTotal} un.
                    </Text>
                    <Text style={styles.checkLegenda}>1ª caixa = carregado · 2ª caixa = entregue</Text>
                    {itens.map((it, idx) => (
                      <View key={`${it.codigo}-${idx}`} style={styles.checkLinha}>
                        <Text style={styles.checkBox}>[ ]</Text>
                        <Text style={styles.checkBox}>[ ]</Text>
                        <Text style={styles.checkQtd}>{it.quantidade} un.</Text>
                        <Text style={styles.checkNome}>
                          {it.codigo ? `${it.codigo} — ` : ""}{it.nome}
                        </Text>
                      </View>
                    ))}
                  </View>
                )}
                <View style={styles.assinatura}>
                  <Text>Assinatura do recebedor</Text>
                </View>
              </View>
            </View>
          </View>
          );
        })}
    </View>
  );
}

function Rodape({ emitenteNome }: { emitenteNome: string }) {
  return (
    <View style={styles.rodape} fixed>
      <Text>{emitenteNome}</Text>
      <Text
        render={({ pageNumber, totalPages }: { pageNumber: number; totalPages: number }) =>
          `Página ${pageNumber} de ${totalPages}`
        }
      />
    </View>
  );
}

export async function renderRomaneioPdf(
  emitente: { nome: string },
  carga: RomaneioDados,
): Promise<Buffer> {
  const buf = await renderToBuffer(<RomaneioPdf emitente={emitente} carga={carga} />);
  return buf as Buffer;
}

export async function renderRomaneioEFechamentoPdf(
  emitente: { nome: string },
  carga: RomaneioEFechamentoDados,
  emitidoEm: string,
): Promise<Buffer> {
  const buf = await renderToBuffer(
    <RomaneioEFechamentoPdf emitente={emitente} carga={carga} emitidoEm={emitidoEm} />,
  );
  return buf as Buffer;
}
