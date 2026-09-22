/**
 * GEOCODIFICAÇÃO servidor — Nominatim com ritmo justo e cache no contato.
 *
 * O mapa antigo geocodificava no NAVEGADOR, 1 req/s por endereço, a cada
 * abertura. Agora o servidor resolve (mesma fila de 1,1s entre chamadas,
 * User-Agent honesto, `countrycodes=br`) e grava em `contacts` — a segunda
 * abertura não reconsulta nada. Sem localização, a parada vai para a lista
 * de "sem mapa", nunca para um ponto inventado.
 */

export type EstadoGeo = "ok" | "nao_encontrado" | "ambiguo" | "erro";

/** O quanto o ponto vale: número certo, rua aproximada ou só cidade. */
export type PrecisaoGeo = "numero" | "rua" | "cidade";

export interface ResultadoGeo {
  estado: EstadoGeo;
  latitude: number | null;
  longitude: number | null;
  precisao: PrecisaoGeo | null;
}

export interface PartesEndereco {
  logradouro?: string | null;
  numero_end?: string | null;
  bairro?: string | null;
  cidade?: string | null;
  uf?: string | null;
}

/** "268 sala03" → "268"; "SN"/"S/N"/"KM 258" → null (não é número de porta). */
export function normalizarNumero(valor: string | null | undefined): string | null {
  const v = (valor ?? "").trim().toUpperCase();
  if (v === "" || v === "SN" || v === "S/N" || /^KM\b/.test(v)) return null;
  const m = v.match(/\d+/);
  return m ? m[0] : null;
}

const ABREVIACOES: [RegExp, string][] = [
  [/\bR\.?(?=[\s.,]|$)/g, "Rua"],
  [/\bAV\.?(?=[\s.,]|$)/gi, "Avenida"],
  [/\bCEL\.?(?=[\s.,]|$)/gi, "Coronel"],
  [/\bMAL\.?(?=[\s.,]|$)/gi, "Marechal"],
  [/\bGOV\.?(?=[\s.,]|$)/gi, "Governador"],
  [/\bROD\.?(?=[\s.,]|$)/gi, "Rodovia"],
  [/\bEST\.?(?=[\s.,]|$)/gi, "Estrada"],
  [/\bPCA\.?(?=[\s.,]|$)/gi, "Praça"],
  [/\bJD\.?(?=[\s.,]|$)/gi, "Jardim"],
];

/** "R CEL ALBUQUERQUE" → "Rua Coronel ALBUQUERQUE". */
export function expandirAbreviacoes(rua: string): string {
  // "AV.GOV.Jorge" (ponto sem espaço): separa antes de expandir.
  let s = rua
    .trim()
    .replace(/([A-Za-z])\.([A-Za-z])/g, "$1 $2")
    .replace(/\s+/g, " ");
  for (const [re, por] of ABREVIACOES) s = s.replace(re, por);
  return s.replace(/\s+/g, " ").trim();
}

// Complemento colado onde era para ser bairro/número ("LOJA", "FUNDOS",
// "SALA 3", "CASA") envenena a consulta: o Nominatim procura literalmente.
const COMPLEMENTOS =
  /\b(LOJAS?|SALAS?|SOBRELOJA|CASAS?|FUNDOS|FRENTE|PREDIOS?|PRÉDIOS?|GALP(O|AO|ÕES)|BOX|QUIOSQUE|PISO|SUPERIOR|TERREO|TÉRREO|ALTOS|BAIXOS|SOBRADO|BARRACA?O|BARRACÕES|CXPST|CAIXA POSTAL|CX POSTAL|SN|S\/N)\s*\d*\b\.?/gi;

// Faixa de numeração do cadastro ("... , ATÉ 599/600", "DE 500/501 AO FIM",
// "... DE 1400 A 2298 LADO PAR") e referência antiga ("antiga panif arco
// iris"): não são endereço, e o Nominatim tenta casar literalmente.
const FAIXAS = /\s+AT[EÉ]\s.*$/i;
const ATE_AO_FIM = /\s+DE\s+[\d/\s]+\s+AO\s+FIM.*$/i;
const LADO_PAR_IMPAR = /\s+DE\s+[\d/\s]+\s+A\s+[\d/\s]+.*LADO\s+(PAR|ÍMPAR).*$/i;
const LADO_SOZINHO = /\s+LADO\s+(PAR|ÍMPAR).*$/i;
// Faixa sem "lado" ("... , 771, DE 120/121 A 899/900"): resto de numeração
// do cadastro. Exige dígitos dos dois lados para não comer nome de rua.
const FAIXA_DE_A = /,?\s*DE\s+\d[\d/\s]*\s+A\s+\d.*$/i;
const REFERENCIA_ANTIGA = /\s+ANTIGA?\b.*$/i;

/** Tira complemento do trecho sem apagar o resto ("268 sala03" → "268"). */
export function limparComplemento(trecho: string): string {
  // NFC primeiro: "ÃO" decomposto (A + ~ combinante) tem fronteira no meio
  // e o corte de letra solta comeria o O de BARÃO/SÃO — medido nas duas
  // formas, não confiar na forma que o banco entrega.
  const semFaixa = expandirAbreviacoes(trecho.normalize("NFC"))
    .replace(FAIXAS, " ")
    .replace(ATE_AO_FIM, " ")
    .replace(LADO_PAR_IMPAR, " ")
    .replace(LADO_SOZINHO, " ")
    .replace(FAIXA_DE_A, " ")
    .replace(REFERENCIA_ANTIGA, " ")
    // "NULL" e "***" do export do WP/Mercos ("FERREIRA 505 NULL").
    .replace(/\bNULL\b\.?/gi, " ")
    .replace(/\*+/g, " ")
    // "n.177"/"Nº 45" → número puro (o normalizarNumero extrai os dígitos).
    .replace(/\bN\.?º?\s*(?=\d)/gi, "")
    // Letra solta no MEIO ("CAMPOS S SALES" → "CAMPOS SALES"): inicial
    // perdida do cadastro. Só maiúscula seguida de outra palavra — "RUA X"
    // no fim pode ser o nome de verdade e fica. Lookaround com \p{L} de
    // propósito: o \b não enxerga o Ã como letra (medido no Node 24) e
    // comia o O de BARÃO/SÃO.
    .replace(/(?<![\p{L}\d])[A-Z]\.?(?![\p{L}\d])(?=\s+\S)/gu, "");
  return semFaixa.replace(COMPLEMENTOS, " ").replace(/\s+/g, " ").replace(/^[,\-–\s]+|[,\-–\s]+$/g, "").trim();
}

/**
 * A rua sem o número colado: o WP importava "rua + número" no logradouro E o
 * número separado ("RUA X, 65" + "65" → consulta "65, 65", que o Nominatim
 * não entende).
 */
export function ruaSemNumeroColado(logradouro: string, numero: string | null): string {
  let rua = logradouro.trim().replace(/\s+/g, " ");
  if (rua && numero) {
    const esc = numero.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    rua = rua.replace(new RegExp(`[\\s,\\-]+${esc}$`, "i"), "").trim();
  }
  return rua;
}

/**
 * A cadeia de consultas, da mais exata para a mais solta. Cada fase existe
 * por um envenenamento medido (sondar-variantes.ts, 2026-09-06/07):
 * 1. rua + número (o exato, quando o OSM tem o imóvel);
 * 2. rua + cidade (número com "sala03" ou inexistente não mata a rua);
 * 3. nome sem tipo + número ("Av. Rubens Ribeiro" × OSM "Rua Rubens
 *    Ribeiro": tipo trocado no cadastro zera tudo, mas sem tipo + número
 *    o Nominatim cai para os trechos da rua);
 * 4. primeiro trecho + cidade (lixo irredutível no fim — "systen som");
 * 5. rua + cidade sem UF (cadastro com UF trocada: Canoinhas/PR).
 * A rua já sai normalizada (abreviatura expandida, complemento fora);
 * bairro entra quando é bairro de verdade.
 */
export function montarConsultas(p: PartesEndereco): string[] {
  const ruaLimpa = limparComplemento(p.logradouro ?? "");
  let numero = normalizarNumero(p.numero_end);
  // Número colado no fim do logradouro sem campo separado ("RUA X, 100"):
  // vale como número (exige a vírgula — "TRAVESSA 7" é nome, não número).
  if (!numero) numero = ruaLimpa.match(/,\s*(\d{1,6})\s*$/)?.[1] ?? null;
  const rua = ruaSemNumeroColado(ruaLimpa, numero);
  const cidade = (p.cidade ?? "").trim().replace(/\s+/g, " ");
  const uf = (p.uf ?? "").trim().toUpperCase();
  if (!rua || !cidade) return [];
  const bairroLimpo = limparComplemento(p.bairro ?? "");
  const bairroVale = bairroLimpo.length >= 3 ? [bairroLimpo] : [];
  const base = [...bairroVale, cidade, uf, "Brasil"].filter(Boolean).join(", ");
  const cadeia: string[] = [];
  if (numero) cadeia.push(`${rua}, ${numero}, ${base}`);
  cadeia.push(`${rua}, ${cidade}, ${uf}, Brasil`.replace(/, ,/g, ","));
  if (numero) {
    const semTipo = semTipoVial(rua);
    if (semTipo && semTipo.toLowerCase() !== rua.toLowerCase()) {
      cadeia.push(`${semTipo}, ${numero}, ${base}`);
    }
  }
  // Último recurso antes do manual: primeiro trecho (rua sem o lixo do fim).
  const primeiroTrecho = rua.split(",")[0]?.trim() ?? "";
  const trechoUtil = primeiroTrecho || rua;
  if (primeiroTrecho && primeiroTrecho.toLowerCase() !== rua.toLowerCase()) {
    cadeia.push(`${primeiroTrecho}, ${cidade}, ${uf}, Brasil`.replace(/, ,/g, ","));
  }
  // UF trocada no cadastro (Canoinhas/PR): sem UF o Nominatim resolve.
  cadeia.push(`${trechoUtil}, ${cidade}, Brasil`);
  return [...new Set(cadeia)];
}

/**
 * Nome sem o tipo de via ("Avenida Rubens Ribeiro da Silva" → "Rubens
 * Ribeiro da Silva"). O cadastro chama de Av. o que o OSM chama de Rua (e
 * vice-versa); sem o tipo, com número, o Nominatim encontra os trechos.
 */
export function semTipoVial(rua: string): string {
  return rua
    .replace(
      /^(rua|avenida|travessa|trav|alameda|rodovia|estrada|praça|praca|largo|viela|beco|passarela|via)\b\.?\s*/i,
      "",
    )
    .trim();
}

const NOMINATIM = "https://nominatim.openstreetmap.org/search";

// Ritmo justo da instância pública: serializa as chamadas do processo com
// 1,1s entre elas. Sem isso, rajada de carga com 20 paradas = bloqueio.
let ultimaChamada = 0;
let fila: Promise<void> = Promise.resolve();

function reservarVez(): Promise<void> {
  const vez = fila.then(async () => {
    const espera = 1100 - (Date.now() - ultimaChamada);
    if (espera > 0) await new Promise((r) => setTimeout(r, espera));
    ultimaChamada = Date.now();
  });
  // A fila nunca quebra por causa de um chamador que falhou.
  fila = vez.catch(() => undefined);
  return vez;
}

function ua(): string {
  return (process.env.GEOCODER_UA ?? "DeskcommCRM-Rotas/1.0").trim() || "DeskcommCRM-Rotas/1.0";
}

export async function geocodificarEndereco(endereco: string, cidade?: string | null, uf?: string | null): Promise<ResultadoGeo> {
  const consulta = [endereco.trim(), cidade?.trim(), uf?.trim(), "Brasil"].filter(Boolean).join(", ");
  if (!consulta) return { estado: "erro", latitude: null, longitude: null, precisao: null };
  return buscar(consulta);
}

/**
 * Linha do pedido ("RUA X, 65 — BAIRRO, CIDADE/UF, 89520000") de volta para
 * partes: o pedido avulso (sem contato estruturado) também merece a cadeia
 * completa, não um chute único.
 */
export function parseLinhaEndereco(linha: string): PartesEndereco {
  const [esq, dir] = linha.split(/[—–]/).map((s) => (s ?? "").trim());
  const resto = (dir ?? "").split(",").map((s) => s.trim());
  // "BAIRRO, CIDADE/UF, CEP" ou "CIDADE/UF, ..." ou só "CIDADE/UF".
  let cidade: string | null = null;
  let uf: string | null = null;
  let bairro: string | null = null;
  for (const seg of resto) {
    const m = seg.match(/^(.+?)\s*\/\s*([A-Za-z]{2})$/);
    if (m && !cidade) {
      cidade = m[1]?.trim() || null;
      uf = m[2]?.trim() || null;
    } else if (!cidade && !/^\d{5}-?\d{3}$/.test(seg) && seg) {
      bairro = bairro ? `${bairro}, ${seg}` : seg;
    }
  }
  return { logradouro: esq || null, numero_end: null, bairro, cidade, uf };
}

/**
 * Geocodifica com a cadeia de fallback: tenta cada consulta em ordem e fica
 * com o primeiro "ok" — com número exato ganhando da rua aproximada. O
 * "não localizado" final significa OSM sem a rua mesmo (medido: interior),
 * não consulta malformada — aí o caminho é marcar no mapa.
 */
export async function geocodificarComFallback(p: PartesEndereco, linhaPedido?: string | null): Promise<ResultadoGeo> {
  let cadeia = montarConsultas(p);
  // Sem rua no cadastro, destrincha a linha do pedido e tenta a cadeia nela.
  if (cadeia.length === 0 && linhaPedido?.trim()) {
    cadeia = montarConsultas(parseLinhaEndereco(linhaPedido));
  }
  // Último suspiro: a linha crua (o Nominatim às vezes entende o que a
  // normalização desmontou).
  const crua = linhaPedido?.trim() ? [`${linhaPedido.trim()}, Brasil`] : [];
  let viuErro = false;
  for (const consulta of [...cadeia, ...crua]) {
    const r = await buscar(consulta);
    if (r.estado === "ok") return r;
    if (r.estado === "erro") viuErro = true;
    // nao_encontrado/ambiguo: próxima fase (mais solta) pode resolver.
  }
  if (cadeia.length === 0 && crua.length === 0) return { estado: "erro", latitude: null, longitude: null, precisao: null };
  return { estado: viuErro ? "erro" : "nao_encontrado", latitude: null, longitude: null, precisao: null };
}

async function buscar(consulta: string): Promise<ResultadoGeo> {
  await reservarVez();
  const controle = new AbortController();
  const limite = setTimeout(() => controle.abort(), 15000);
  try {
    const res = await fetch(
      `${NOMINATIM}?q=${encodeURIComponent(consulta)}&format=json&limit=5&countrycodes=br&addressdetails=1`,
      { headers: { "User-Agent": ua(), Accept: "application/json" }, signal: controle.signal },
    );
    if (!res.ok) return { estado: "erro", latitude: null, longitude: null, precisao: null };
    const j = (await res.json()) as {
      lat?: string;
      lon?: string;
      addresstype?: string;
      address?: { road?: string; house_number?: string; city?: string; town?: string; village?: string };
    }[];
    if (!j || j.length === 0) return { estado: "nao_encontrado", latitude: null, longitude: null, precisao: null };
    const primeiro = j[0]!;
    const lat = Number(primeiro.lat);
    const lng = Number(primeiro.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return { estado: "erro", latitude: null, longitude: null, precisao: null };
    }
    // Número certo: o OSM conhece o imóvel (housenumber ou addresstype).
    if (primeiro.address?.house_number || primeiro.addresstype === "house" || primeiro.addresstype === "building") {
      return { estado: "ok", latitude: lat, longitude: lng, precisao: "numero" };
    }
    // Rua aproximada: todos os candidatos são a mesma rua na mesma cidade
    // (o OSM do interior raramente tem número — o trecho basta para a rota,
    // e a tela diz que é aproximado em vez de fingir exatidão).
    const rua = (primeiro.address?.road ?? "").toLowerCase();
    const cidadeRes = (primeiro.address?.city ?? primeiro.address?.town ?? primeiro.address?.village ?? "").toLowerCase();
    const mesmaRua = rua !== "" && j.every((c) => (c.address?.road ?? "").toLowerCase() === rua);
    const mesmaCidade =
      cidadeRes === "" || j.every((c) => (c.address?.city ?? c.address?.town ?? c.address?.village ?? "").toLowerCase() === cidadeRes);
    if (mesmaRua && mesmaCidade) {
      return { estado: "ok", latitude: lat, longitude: lng, precisao: "rua" };
    }
    return { estado: "ambiguo", latitude: null, longitude: null, precisao: null };
  } catch {
    return { estado: "erro", latitude: null, longitude: null, precisao: null };
  } finally {
    clearTimeout(limite);
  }
}
