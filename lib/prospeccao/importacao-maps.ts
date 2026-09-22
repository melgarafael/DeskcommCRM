import type { NegocioDescoberto } from "./tipos";

/**
 * A PONTE DO GOOGLE MAPS SCRAPER — do export do userscript ao contrato.
 *
 * O userscript (Tampermonkey, Firefox) exporta JSON/CSV com estes campos:
 * name, fullAddress, phones, website, averageRating, reviewCount, categories,
 * emails, plusCode (+ placeId, latitude, longitude, googleMapsURL...). Esta
 * função aceita o JSON já parseado (array de objetos) e devolve negócios no
 * contrato `NegocioDescoberto` — daqui para frente é o fluxo normal:
 * normalização, dedup, score e insert do motor.
 *
 * Função pura (sem banco, sem rede): linha ruim vira `recusada` nomeando o
 * motivo, nunca exceção e nunca chute. Telefone/email/endereço passam crus —
 * quem normaliza é `normalizacao.ts` + motor, um só lugar.
 */

export const MAX_LINHAS_ARQUIVO = 2000;

export interface LinhaRecusada {
  linha: number;
  motivo: string;
}

export interface ArquivoMapsPronto {
  negocios: NegocioDescoberto[];
  recusadas: LinhaRecusada[];
  total: number;
}

function texto(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

function numero(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v !== "string" || v.trim() === "") return null;
  const n = Number(v.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function inteiro(v: unknown): number | null {
  const n = numero(v);
  if (n === null || !Number.isInteger(n) || n < 0) return null;
  return n;
}

/** "a, b" ou ["a", "b"] → ["a", "b"] (primeiro não-vazio na frente). */
function lista(v: unknown): string[] {
  const bruta: unknown[] = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [];
  const limpa = bruta.map((x) => (typeof x === "string" ? x.trim() : "")).filter((x) => x !== "");
  return [...new Set(limpa)];
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function mapearExportMaps(entrada: unknown): ArquivoMapsPronto {
  if (!Array.isArray(entrada)) {
    return { negocios: [], recusadas: [{ linha: 0, motivo: "o arquivo não é uma lista (use o Export JSON do userscript)" }], total: 0 };
  }
  const negocios: NegocioDescoberto[] = [];
  const recusadas: LinhaRecusada[] = [];
  const limite = Math.min(entrada.length, MAX_LINHAS_ARQUIVO);

  for (let i = 0; i < limite; i++) {
    const linha = i + 1;
    const r = entrada[i];
    if (!r || typeof r !== "object" || Array.isArray(r)) {
      recusadas.push({ linha, motivo: "linha não é um objeto" });
      continue;
    }
    const o = r as Record<string, unknown>;
    const nome = texto(o["name"]);
    if (!nome) {
      recusadas.push({ linha, motivo: "sem nome (obrigatório)" });
      continue;
    }

    const categorias = lista(o["categories"]);
    const fones = lista(o["phones"]);
    const emails = lista(o["emails"]).filter((e) => EMAIL_RE.test(e));
    const nota = numero(o["averageRating"]);
    const lat = numero(o["latitude"]);
    const lng = numero(o["longitude"]);

    const placeId = texto(o["placeId"]);
    negocios.push({
      idExterno: placeId ? `maps:${placeId}` : null,
      nome,
      categoriaPrincipal: categorias[0] ?? null,
      categoriasSecundarias: categorias.slice(1),
      telefone: fones[0] ?? null,
      website: texto(o["website"]),
      email: emails[0] ?? null,
      endereco: texto(o["fullAddress"]),
      bairro: null,
      cidade: texto(o["municipality"]),
      estado: null,
      cep: null,
      pais: "BR",
      latitude: lat,
      longitude: lng,
      urlExterna: texto(o["googleMapsURL"]),
      nota: nota !== null && nota >= 0 && nota <= 5 ? nota : null,
      totalAvaliacoes: inteiro(o["reviewCount"]) ?? 0,
      horarioFuncionamento: null,
    });
  }

  if (entrada.length > limite) {
    recusadas.push({ linha: 0, motivo: `${entrada.length - limite} linha(s) além do teto de ${MAX_LINHAS_ARQUIVO} ignoradas` });
  }
  return { negocios, recusadas, total: entrada.length };
}
