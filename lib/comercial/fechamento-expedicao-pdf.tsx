/**
 * O FECHAMENTO DA CARGA — prestação de contas da rota + caixa manual.
 *
 * Não é um documento separado: é a SEGUNDA METADE do PDF único da carga
 * (`RomaneioEFechamentoPdf` em `romaneio-pdf.tsx`) — romaneio na frente,
 * fechamento atrás, mesma folha impressa. Este arquivo exporta o conteúdo
 * (`ConteudoFechamento`) e a matemática (`resumoDoFechamento`,
 * `aCobrarPorCondicao`), ambas testáveis sem PDF.
 *
 * Honestidade do documento (o que o banco NÃO tem não é inventado):
 * - "Recebido / meio" por parada sai PREENCHIDO só quando o pedido já tem
 *   recebível pago (antecipado/PIX antes da rota); o resto é conferência
 *   física — coluna ☐ para ticar no papel.
 * - Data de saída não existe em `shipments`: o cabeçalho mostra a montagem
 *   (created_at) e a emissão do relatório (agora).
 * - "A cobrar por condição" agrupa pelo texto da condição do pedido
 *   (heurística declarada em `classificarCondicao`) — é preparo de troco,
 *   não fato financeiro.
 */

import { StyleSheet, Text, View } from "@react-pdf/renderer";
import React from "react";

import {
  numeroDaCarga,
  ROTULO_MOTIVO_DEVOLUCAO,
  type MotivoDevolucao,
} from "@/lib/schemas/expedicao";

const MARINHO = "#1e3a5f";
const CINZA = "#6b7280";
const BORDA = "#e5e7eb";
const FUNDO = "#f3f4f6";

export const stylesFechamento = StyleSheet.create({
  cartao: { border: `0.5pt solid ${BORDA}`, borderRadius: 4, marginBottom: 10 },
  cartaoTitulo: {
    fontSize: 10,
    fontWeight: "bold",
    color: MARINHO,
    backgroundColor: FUNDO,
    paddingVertical: 5,
    paddingHorizontal: 8,
  },
  cartaoCorpo: { flexDirection: "row", padding: 8, gap: 10 },
  resumoItem: { flex: 1 },
  resumoRotulo: { fontSize: 8, color: CINZA, textTransform: "uppercase" },
  resumoValor: { fontSize: 12, fontWeight: "bold" },
  tabelaCab: {
    flexDirection: "row",
    backgroundColor: MARINHO,
    color: "#ffffff",
    fontSize: 8,
    fontWeight: "bold",
    paddingVertical: 5,
    paddingHorizontal: 3,
  },
  tabelaLinha: { flexDirection: "row", fontSize: 8, paddingVertical: 4, paddingHorizontal: 3 },
  zebra: { backgroundColor: "#f9fafb" },
  colSeq: { width: "5%" },
  colPed: { width: "10%" },
  colCli: { width: "19%" },
  colCond: { width: "12%" },
  colSit: { width: "10%" },
  colVol: { width: "6%", textAlign: "right" },
  colValor: { width: "11%", textAlign: "right" },
  colReceb: { width: "10%", textAlign: "right" },
  colCobrar: { width: "11%", textAlign: "right" },
  colConf: { width: "6%", textAlign: "center" },
  detalheMotivo: { fontSize: 7, color: CINZA },
  caixaLinha: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
    paddingVertical: 5,
    borderBottom: `0.5pt dotted ${BORDA}`,
    fontSize: 10,
  },
  caixaTotal: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
    paddingVertical: 6,
    marginTop: 2,
    borderTop: `1pt solid ${MARINHO}`,
    fontSize: 11,
    fontWeight: "bold",
    color: MARINHO,
  },
  linhaPreencher: { width: 130, borderBottom: "0.5pt solid #1f2937", height: 12 },
  obs: { marginTop: 6, fontSize: 9, color: "#4b5563", border: `0.5pt solid ${BORDA}`, borderRadius: 4, padding: 8, minHeight: 30 },
  obsItem: { fontSize: 9, marginBottom: 3 },
  assinaturas: { flexDirection: "row", gap: 24, marginTop: 18 },
  assinatura: { flex: 1, borderTop: "0.5pt solid #1f2937", paddingTop: 4, fontSize: 8, color: CINZA, textAlign: "center" },
});

export interface ParadaFechamento {
  sequencia: number;
  numero: number;
  cliente_nome: string;
  endereco_entrega: string | null;
  total_cents: number;
  condicao: string | null;
  situacao: string;
  motivo: string | null;
  entregue_em: string | null;
  volumes: number;
  /** Soma dos recebíveis PAGOS do pedido (antecipado). */
  pago_cents: number;
}

export interface FechamentoCarga {
  numero: number;
  placa: string | null;
  veiculo_tipo: string | null;
  motorista_nome: string | null;
  status: string;
  montada_em: string;
  paradas: ParadaFechamento[];
}

export interface ResumoFechamento {
  totalFaturado: number;
  pagoAntecipado: number;
  aCobrar: number;
  devolvido: number;
  volumes: number;
  concluidas: number;
  pendentes: number;
}

/** A conta do fechamento, pura e testável sem PDF. */
export function resumoDoFechamento(paradas: ParadaFechamento[]): ResumoFechamento {
  let totalFaturado = 0;
  let pagoAntecipado = 0;
  let aCobrar = 0;
  let devolvido = 0;
  let volumes = 0;
  let concluidas = 0;
  for (const p of paradas) {
    totalFaturado += p.total_cents;
    pagoAntecipado += Math.min(p.pago_cents, p.total_cents);
    volumes += p.volumes;
    if (p.situacao === "devolvido") {
      devolvido += p.total_cents;
      concluidas++;
    } else {
      if (p.situacao === "entregue") concluidas++;
      aCobrar += Math.max(0, p.total_cents - p.pago_cents);
    }
  }
  return {
    totalFaturado,
    pagoAntecipado,
    aCobrar,
    devolvido,
    volumes,
    concluidas,
    pendentes: paradas.length - concluidas,
  };
}

/**
 * Agrupa o "a cobrar" pelo texto da condição do pedido — preparo de troco
 * e maquininha, não fato financeiro. A classificação é por palavra-chave
 * (sem acento, minúscula); o que não casa cai em "Outros".
 */
export function classificarCondicao(condicao: string | null): string {
  const t = (condicao ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  if (/(^|\W)(dinheiro|especie)($|\W)/.test(t)) return "Dinheiro";
  if (t.includes("pix")) return "PIX";
  if (/(cartao|debito|credito|maquininha)/.test(t)) return "Cartão";
  if (t.includes("boleto")) return "Boleto";
  if (/(prazo|faturado|\d+\s*dias|30|60|90|28)/.test(t)) return "A prazo";
  if (/(antecipado|a vista|avista|pago)/.test(t)) return "Pago antecipado";
  return "Outros";
}

/** A cobrar (não-devolvidos, abatendo antecipado) por condição informada. */
export function aCobrarPorCondicao(paradas: ParadaFechamento[]): { condicao: string; valor_cents: number }[] {
  const mapa = new Map<string, number>();
  for (const p of paradas) {
    if (p.situacao === "devolvido") continue;
    const falta = Math.max(0, p.total_cents - p.pago_cents);
    if (falta <= 0) continue;
    const chave = classificarCondicao(p.condicao);
    mapa.set(chave, (mapa.get(chave) ?? 0) + falta);
  }
  return [...mapa.entries()]
    .map(([condicao, valor_cents]) => ({ condicao, valor_cents }))
    .sort((a, b) => b.valor_cents - a.valor_cents);
}

function moeda(cents: number): string {
  return `R$ ${(cents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`;
}

function dataFmt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
}

function horaFmt(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return ` ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

function rotuloMotivo(motivo: string | null): string {
  if (!motivo) return "";
  return ROTULO_MOTIVO_DEVOLUCAO[motivo as MotivoDevolucao] ?? motivo;
}

/** O fechamento como conteúdo (sem Document/Page): compõe o PDF único. */
export function ConteudoFechamento({
  carga,
  emitidoEm,
}: {
  carga: FechamentoCarga;
  emitidoEm: string;
}): React.JSX.Element {
  const resumo = resumoDoFechamento(carga.paradas);
  const porCondicao = aCobrarPorCondicao(carga.paradas);
  const devolvidas = carga.paradas.filter((p) => p.situacao === "devolvido");
  const s = stylesFechamento;
  return (
    <View>
      <View style={s.cartao}>
        <Text style={s.cartaoTitulo}>Fechamento {numeroDaCarga(carga.numero)} — resumo financeiro</Text>
        <View style={s.cartaoCorpo}>
          <View style={s.resumoItem}>
            <Text style={s.resumoRotulo}>Total faturado</Text>
            <Text style={s.resumoValor}>{moeda(resumo.totalFaturado)}</Text>
          </View>
          <View style={s.resumoItem}>
            <Text style={s.resumoRotulo}>Pago antecipado</Text>
            <Text style={s.resumoValor}>{moeda(resumo.pagoAntecipado)}</Text>
          </View>
          <View style={s.resumoItem}>
            <Text style={s.resumoRotulo}>A cobrar na entrega</Text>
            <Text style={s.resumoValor}>{moeda(resumo.aCobrar)}</Text>
          </View>
          <View style={s.resumoItem}>
            <Text style={s.resumoRotulo}>Devolvido</Text>
            <Text style={s.resumoValor}>{moeda(resumo.devolvido)}</Text>
          </View>
          <View style={s.resumoItem}>
            <Text style={s.resumoRotulo}>Volumes</Text>
            <Text style={s.resumoValor}>{resumo.volumes} un.</Text>
          </View>
        </View>
      </View>

      <View style={s.cartao}>
        <Text style={s.cartaoTitulo}>
          Cobrança por parada ({resumo.concluidas} concluídas · {resumo.pendentes} pendentes)
        </Text>
        <View style={s.tabelaCab}>
          <Text style={s.colSeq}>Seq</Text>
          <Text style={s.colPed}>Pedido</Text>
          <Text style={s.colCli}>Cliente</Text>
          <Text style={s.colCond}>Condição</Text>
          <Text style={s.colSit}>Situação</Text>
          <Text style={s.colVol}>Vol.</Text>
          <Text style={s.colValor}>Total</Text>
          <Text style={s.colReceb}>Receb.</Text>
          <Text style={s.colCobrar}>A cobrar</Text>
          <Text style={s.colConf}>☐</Text>
        </View>
        {carga.paradas.map((p, i) => {
          const falta = p.situacao === "devolvido" ? 0 : Math.max(0, p.total_cents - p.pago_cents);
          return (
            <View key={i} style={[s.tabelaLinha, i % 2 === 1 ? s.zebra : undefined]}>
              <Text style={s.colSeq}>{p.sequencia}</Text>
              <Text style={s.colPed}>#{p.numero}</Text>
              <View style={s.colCli}>
                <Text>{p.cliente_nome}</Text>
                {(p.situacao === "devolvido" || p.situacao === "entregue") && (
                  <Text style={s.detalheMotivo}>
                    {[rotuloMotivo(p.situacao === "devolvido" ? p.motivo : null), horaFmt(p.entregue_em)]
                      .filter(Boolean)
                      .join(" · ")}
                  </Text>
                )}
              </View>
              <Text style={s.colCond}>{p.condicao?.trim() ? p.condicao : "—"}</Text>
              <Text style={s.colSit}>{p.situacao}</Text>
              <Text style={s.colVol}>{p.volumes || "—"}</Text>
              <Text style={s.colValor}>{moeda(p.total_cents)}</Text>
              <Text style={s.colReceb}>{p.pago_cents >= p.total_cents && p.total_cents > 0 ? "Pago" : ""}</Text>
              <Text style={s.colCobrar}>{falta > 0 ? moeda(falta) : "—"}</Text>
              <Text style={s.colConf}>☐</Text>
            </View>
          );
        })}
      </View>

      {porCondicao.length > 0 && (
        <View style={s.cartao}>
          <Text style={s.cartaoTitulo}>A cobrar por condição informada (prepare troco e maquininha)</Text>
          <View style={s.cartaoCorpo}>
            {porCondicao.map((g) => (
              <View key={g.condicao} style={s.resumoItem}>
                <Text style={s.resumoRotulo}>{g.condicao}</Text>
                <Text style={s.resumoValor}>{moeda(g.valor_cents)}</Text>
              </View>
            ))}
          </View>
        </View>
      )}

      <View style={s.cartao}>
        <Text style={s.cartaoTitulo}>Conferência e fechamento de caixa (preenchimento manual)</Text>
        <View style={{ padding: 8 }}>
          <LinhaCaixa rotulo="Dinheiro em espécie contado" />
          <LinhaCaixa rotulo="Comprovantes de PIX" />
          <LinhaCaixa rotulo="Canhotos de cartão (débito/crédito)" />
          <LinhaCaixa rotulo="Cheques recebidos" />
          <LinhaCaixa rotulo="Boletos entregues / assinados" />
          <LinhaCaixa rotulo="(−) Vale ao motorista (adiantamento)" />
          <LinhaCaixa rotulo="(−) Combustível / pedágio" />
          <LinhaCaixa rotulo="(−) Outras despesas autorizadas de viagem" />
          <View style={s.caixaTotal}>
            <Text>Total líquido entregue ao caixa</Text>
            <Text>R$ ______________</Text>
          </View>
          <View style={s.caixaLinha}>
            <Text>Total esperado para cobrança</Text>
            <Text>{moeda(resumo.aCobrar)}</Text>
          </View>
          <View style={s.caixaTotal}>
            <Text>Diferença (sobra / falta)</Text>
            <Text>R$ ______________</Text>
          </View>
        </View>
      </View>

      <View style={s.cartao}>
        <Text style={s.cartaoTitulo}>Ocorrências de rota e devoluções</Text>
        <View style={s.obs}>
          {devolvidas.length === 0 ? (
            <Text> </Text>
          ) : (
            devolvidas.map((p, i) => (
              <Text key={i} style={s.obsItem}>
                #{p.numero} · {p.cliente_nome} · {rotuloMotivo(p.motivo) || "sem motivo registrado"} ·{" "}
                {moeda(p.total_cents)}
              </Text>
            ))
          )}
        </View>
      </View>

      <View style={s.assinaturas}>
        <View style={s.assinatura}>
          <Text>Motorista / entregador — nome e assinatura</Text>
        </View>
        <View style={s.assinatura}>
          <Text>Conferente / caixa — nome e assinatura</Text>
        </View>
      </View>
      <View style={s.assinaturas}>
        <View style={s.assinatura}>
          <Text>
            Conferência em {dataFmt(emitidoEm)} ____:____ · Motorista: {carga.motorista_nome ?? "—"}
          </Text>
        </View>
      </View>
    </View>
  );
}

function LinhaCaixa({ rotulo }: { rotulo: string }): React.JSX.Element {
  const s = stylesFechamento;
  return (
    <View style={s.caixaLinha}>
      <Text>{rotulo}</Text>
      <View style={s.linhaPreencher} />
    </View>
  );
}
