/**
 * O GERADOR DO SPED (Gera Arquivo) — RASCUNHO estrutural, não arquivo pronto.
 *
 * Monta os blocos 0, C e 9 da EFD ICMS/IPI a partir das notas AUTORIZADAS
 * do período + itens do pedido (NCM/CFOP/unidade do produto). O que o app
 * não sabe, ele zera e DIZ:
 * - CST/CSOSN, bases, alíquotas e apuração saem zerados/vazios — tributação
 *   presumida é crime fiscal, então o rascunho marca o que falta e quem
 *   completa é o contador no PVA antes de transmitir;
 * - CFOP do item = CFOP do produto, ou o padrão da config, passando pelo
 *   de/para de CFOPs Equivalentes;
 * - contadores (C990, 9900, 9990, 9999) são calculados de verdade e cobertos
 *   por teste: arquivo com contador errado nem abre no PVA.
 *
 * Função pura: entra dado, sai texto. Sem banco, sem rede, testável.
 */

export interface EmitenteEfd {
  nome: string;
  cnpj: string;
  ie: string;
  uf: string;
  codigo_municipio: string;
  crt: string;
}

export interface ItemEfd {
  codigo: string;
  descricao: string;
  ncm: string | null;
  cfop: string | null;
  unidade: string | null;
  quantidade: number;
  preco_cents: number;
  desconto_cents: number;
}

export interface NotaEfd {
  serie: string;
  numero: number;
  chave: string;
  emissao: string; // ISO (YYYY-MM-DD ou datetime)
  cliente_nome: string;
  cliente_documento: string | null;
  total_cents: number;
  desconto_cents: number;
  frete_cents: number;
  itens: ItemEfd[];
}

export interface GerarEfdEntrada {
  emitente: EmitenteEfd;
  ano: number;
  mes: number; // 1–12
  cfopPadrao: string;
  equivalentes: Record<string, string>; // origem -> destino
  notas: NotaEfd[];
}

export interface GerarEfdSaida {
  arquivo: string;
  linhas: number;
  notas: number;
  itens: number;
  inicio: string; // DDMMYYYY
  fim: string; // DDMMYYYY
  /** O que o contador precisa completar no PVA antes de transmitir. */
  pendencias: string[];
}

/** EFD usa vírgula decimal, sem separador de milhar. */
export function formatoEfd(cents: number): string {
  const sinal = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  const inteiros = Math.floor(abs / 100).toString();
  const dec = (abs % 100).toString().padStart(2, "0");
  return `${sinal}${inteiros},${dec}`;
}

/** Quantidade com até 3 decimais, vírgula decimal, sem zeros à toa. */
export function quantidadeEfd(qtd: number): string {
  const arred = Math.round(qtd * 1000) / 1000;
  return arred.toString().replace(".", ",");
}

export function soDigitos(v: string | null | undefined): string {
  return (v ?? "").replace(/\D/g, "");
}

function dataEfd(iso: string): string {
  const d = new Date(iso);
  const dia = d.getUTCDate().toString().padStart(2, "0");
  const mes = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  return `${dia}${mes}${d.getUTCFullYear()}`;
}

function ultimoDia(ano: number, mes: number): number {
  return new Date(Date.UTC(ano, mes, 0)).getUTCDate();
}

type Registro = string[];

export function gerarEfd(entrada: GerarEfdEntrada): GerarEfdSaida {
  const { emitente, ano, mes, cfopPadrao, equivalentes, notas } = entrada;
  const ini = `01${mes.toString().padStart(2, "0")}${ano}`;
  const fim = `${ultimoDia(ano, mes).toString().padStart(2, "0")}${mes.toString().padStart(2, "0")}${ano}`;

  const bloco0: Registro[] = [];
  const blocoC: Registro[] = [];
  const temMovimento = notas.length > 0;

  bloco0.push([
    "0000", "019", "0", ini, fim,
    emitente.nome.slice(0, 60), soDigitos(emitente.cnpj), "", emitente.uf,
    soDigitos(emitente.ie), emitente.codigo_municipio, "", "", "A", "1",
  ]);
  bloco0.push(["0001", temMovimento ? "0" : "1"]);

  // Participantes: um código por documento distinto.
  const codParte = new Map<string, string>();
  let seqParte = 0;
  for (const n of notas) {
    const doc = soDigitos(n.cliente_documento);
    const chave = doc === "" ? `nome:${n.cliente_nome}` : `doc:${doc}`;
    if (!codParte.has(chave)) {
      seqParte += 1;
      codParte.set(chave, `C${seqParte.toString().padStart(5, "0")}`);
    }
  }
  const visto = new Set<string>();
  for (const n of notas) {
    const doc = soDigitos(n.cliente_documento);
    const chave = doc === "" ? `nome:${n.cliente_nome}` : `doc:${doc}`;
    if (visto.has(chave)) continue;
    visto.add(chave);
    bloco0.push([
      "0150", codParte.get(chave) ?? "", n.cliente_nome.slice(0, 60), "1058",
      doc.length === 14 ? doc : "", doc.length === 11 ? doc : "",
      "", "", "", "", "", "", "",
    ]);
  }

  // Produtos e unidades distintos.
  const unidades = new Set<string>();
  const produtos = new Map<string, { descricao: string; ncm: string; unidade: string }>();
  for (const n of notas) {
    for (const i of n.itens) {
      const un = (i.unidade ?? "UN").slice(0, 6);
      unidades.add(un);
      if (!produtos.has(i.codigo)) {
        produtos.set(i.codigo, {
          descricao: i.descricao.slice(0, 60),
          ncm: soDigitos(i.ncm).slice(0, 8),
          unidade: un,
        });
      }
    }
  }
  for (const un of [...unidades].sort()) bloco0.push(["0190", un, un]);
  for (const [codigo, p] of [...produtos.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    bloco0.push([
      "0200", codigo.slice(0, 60), p.descricao, "", "", p.unidade, "00",
      p.ncm, "", p.ncm.length >= 2 ? p.ncm.slice(0, 2) : "", "", "",
    ]);
  }
  bloco0.push(["0990", ""]);

  blocoC.push(["C001", temMovimento ? "0" : "1"]);

  // C190 agrega por CFOP (CST sai vazio no rascunho — ver pendencias).
  const agrega190 = new Map<string, number>();
  let totalItens = 0;

  for (const n of notas) {
    const parte = codParte.get(
      soDigitos(n.cliente_documento) === ""
        ? `nome:${n.cliente_nome}`
        : `doc:${soDigitos(n.cliente_documento)}`,
    ) ?? "";
    const mercadoria = n.itens.reduce((a, i) => a + Math.round(i.quantidade * i.preco_cents), 0);
    blocoC.push([
      "C100", "1", "0", parte, "55", "00", n.serie, String(n.numero),
      soDigitos(n.chave), dataEfd(n.emissao), dataEfd(n.emissao),
      formatoEfd(n.total_cents), "2", formatoEfd(n.desconto_cents), formatoEfd(0),
      formatoEfd(mercadoria), n.frete_cents > 0 ? "0" : "9", formatoEfd(n.frete_cents),
      formatoEfd(0), formatoEfd(0), formatoEfd(0), formatoEfd(0), formatoEfd(0),
      formatoEfd(0), formatoEfd(0), formatoEfd(0), formatoEfd(0), formatoEfd(0), formatoEfd(0),
    ]);
    let seq = 0;
    for (const i of n.itens) {
      seq += 1;
      totalItens += 1;
      const base = i.cfop ?? cfopPadrao;
      const cfop = equivalentes[base] ?? base;
      const vlItem = Math.round(i.quantidade * i.preco_cents);
      agrega190.set(cfop, (agrega190.get(cfop) ?? 0) + vlItem - i.desconto_cents);
      blocoC.push([
        "C170", String(seq), i.codigo.slice(0, 60), "", quantidadeEfd(i.quantidade),
        (i.unidade ?? "UN").slice(0, 6), formatoEfd(vlItem), formatoEfd(i.desconto_cents),
        "0", "", cfop, "", formatoEfd(0), formatoEfd(0), formatoEfd(0), formatoEfd(0),
        formatoEfd(0), formatoEfd(0), "0", "", "", formatoEfd(0), formatoEfd(0),
        formatoEfd(0), "", formatoEfd(0), formatoEfd(0), formatoEfd(0), formatoEfd(0),
        formatoEfd(0), "", formatoEfd(0), formatoEfd(0), formatoEfd(0), formatoEfd(0),
        formatoEfd(0), "",
      ]);
    }
  }
  for (const [cfop, valor] of [...agrega190.entries()].sort()) {
    blocoC.push([
      "C190", "", cfop, formatoEfd(0), formatoEfd(valor), formatoEfd(0),
      formatoEfd(0), formatoEfd(0), formatoEfd(0), formatoEfd(0), formatoEfd(0), "",
    ]);
  }
  blocoC.push(["C990", ""]);

  // Contadores: C990 e 9900 contam a si mesmos — preenche depois de contar.
  const qtdC = blocoC.length;
  blocoC[blocoC.length - 1] = ["C990", String(qtdC)];
  bloco0[bloco0.length - 1] = ["0990", String(bloco0.length)];

  const conta: Record<string, number> = {};
  for (const r of [...bloco0, ...blocoC]) {
    const reg = r[0];
    if (reg === undefined) continue;
    conta[reg] = (conta[reg] ?? 0) + 1;
  }

  const bloco9: Registro[] = [["9001", temMovimento ? "0" : "1"]];
  const regs9900 = [...Object.keys(conta).sort(), "9001", "9900", "9990", "9999"].sort();
  for (const reg of regs9900) {
    const qtd =
      reg === "9001" || reg === "9990" || reg === "9999"
        ? 1
        : reg === "9900"
          ? regs9900.length
          : (conta[reg] ?? 0);
    bloco9.push(["9900", reg, String(qtd)]);
  }
  // 9990 conta as linhas do bloco 9 incluindo ele mesmo; 9999 conta o arquivo todo.
  const qtd9 = bloco9.length + 1;
  bloco9.push(["9990", String(qtd9)]);
  const totalLinhas = bloco0.length + blocoC.length + bloco9.length + 1;
  const linhas: string[] = [];
  for (const r of [...bloco0, ...blocoC, ...bloco9]) linhas.push(`|${r.join("|")}|`);
  linhas.push(`|9999|${totalLinhas}|`);

  const pendencias = [
    "CST/CSOSN por item (C170) e apuração de ICMS/IPI/PIS/COFINS saem zerados — complete no PVA com o contador",
    "Conferir COD_VER (019) com a versão vigente no PVA antes de transmitir",
  ];
  if (emitente.crt === "1") {
    pendencias.unshift("Emitente no Simples (CRT 1): o PVA espera CSOSN no campo CST_ICMS do C170");
  }

  return {
    arquivo: linhas.join("\r\n") + "\r\n",
    linhas: totalLinhas,
    notas: notas.length,
    itens: totalItens,
    inicio: ini,
    fim,
    pendencias,
  };
}
