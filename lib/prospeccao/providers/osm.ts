/**
 * OSMOverpassProvider — descoberta gratuita via OpenStreetMap (§2 alternativo).
 *
 * Sem chave, sem faturamento: Overpass QL por bbox + Nominatim para
 * geocodificar. Honestidade sobre os limites:
 * - TEM: nome, endereço, coordenadas, às vezes telefone/site (tags do OSM);
 * - NÃO TEM: avaliações, horário completo, e-mail — score sai menor e é
 *   documentado como tal, não inflado;
 * - COBERTURA varia por cidade (interior de SC é razoável, não total);
 * - RITMO: instância pública pede uso justo — o pacing do motor vale aqui
 *   também, e `OSM_OVERPASS_URL` troca o espelho sem código.
 */

import type {
  BusinessDetails,
  BusinessDiscoveryProvider,
  BusinessSearchParams,
  BusinessSearchResult,
} from "../tipos";

export const OVERPASS_PADRAO = "https://overpass-api.de/api/interpreter";
export const NOMINATIM_PADRAO = "https://nominatim.openstreetmap.org/search";

/**
 * Espelhos em ordem: o oficial primeiro, o comunitário como reserva.
 * Medido: overpass-api.de pode recusar certos egressos com 406 e o kumi
 * exige User-Agent com sentido — por isso UA em toda chamada e failover só
 * em 406/429/5xx/rede (400 é query ruim e repetiria igual no outro).
 */
const ESPELHOS_RESERVA = ["https://overpass.kumi.systems/api/interpreter"];
const UA = "DeskcommCRM-Prospeccao/1.0";

/**
 * Termo comercial (minúsculo) → seletores Overpass. Lista curta de propósito:
 * termo sem mapeamento vira busca textual por nome (fallback abaixo), nunca
 * silêncio — mas o aviso `mapeamento_aproximado` conta ao job.
 */
const MAPA_CATEGORIAS: { casa: RegExp; seletores: string[] }[] = [
  { casa: /oficina|mecanic|auto.eletrica|centro.automotivo/i, seletores: ['["shop"="car_repair"]', '["shop"="car"]'] },
  { casa: /autopecas|auto.pec/i, seletores: ['["shop"="car_parts"]'] },
  { casa: /borracharia|pneu/i, seletores: ['["shop"="tires"]'] },
  { casa: /funilaria|pintura/i, seletores: ['["craft"="painter"]', '["shop"="car_repair"]'] },
  { casa: /lava/i, seletores: ['["amenity"="car_wash"]'] },
  { casa: /revenda|veiculo|concessionaria/i, seletores: ['["shop"="car"]'] },
  { casa: /restaurante/i, seletores: ['["amenity"="restaurant"]'] },
  { casa: /lanchonete|lanche/i, seletores: ['["amenity"="fast_food"]'] },
  { casa: /pizzaria|pizza/i, seletores: ['["amenity"="restaurant"]["cuisine"="pizza"]', '["amenity"="restaurant"]'] },
  { casa: /padaria|panificadora/i, seletores: ['["shop"="bakery"]'] },
  { casa: /supermercado|mercado/i, seletores: ['["shop"="supermarket"]', '["shop"="convenience"]'] },
  { casa: /acougue/i, seletores: ['["shop"="butcher"]'] },
  { casa: /farmacia|drogaria/i, seletores: ['["amenity"="pharmacy"]'] },
  { casa: /odonto|dentista/i, seletores: ['["amenity"="dentist"]'] },
  { casa: /clinica|consultorio|medico/i, seletores: ['["amenity"="clinic"]', '["amenity"="doctors"]'] },
  { casa: /hospital/i, seletores: ['["amenity"="hospital"]'] },
  { casa: /pet|veterin/i, seletores: ['["shop"="pet"]', '["amenity"="veterinary"]'] },
  { casa: /salao|beleza|barbear|estetica|cabel/i, seletores: ['["shop"="hairdresser"]', '["shop"="beauty"]'] },
  { casa: /hotel|pousada|motel|hospedagem/i, seletores: ['["tourism"="hotel"]', '["tourism"="guest_house"]', '["tourism"="motel"]'] },
  { casa: /escola|colegio|curso|idioma|academia|autoescola/i, seletores: ['["amenity"="school"]', '["leisure"="fitness_centre"]'] },
  { casa: /banco/i, seletores: ['["amenity"="bank"]'] },
  { casa: /posto|combustivel/i, seletores: ['["amenity"="fuel"]'] },
  { casa: /material.constru|construcao|madeireira|vidracaria|tinta/i, seletores: ['["shop"="doityourself"]', '["shop"="hardware"]', '["craft"="carpenter"]'] },
  { casa: /moveis|mobili/i, seletores: ['["shop"="furniture"]'] },
  { casa: /roupa|vestuario|calcado|sapato/i, seletores: ['["shop"="clothes"]', '["shop"="shoes"]'] },
  { casa: /papelaria|livraria/i, seletores: ['["shop"="books"]', '["shop"="stationery"]'] },
  { casa: /otica/i, seletores: ['["shop"="optician"]'] },
  { casa: /contab|advoc|imobiliaria|seguro|corretor/i, seletores: ['["office"="accountant"]', '["office"="lawyer"]', '["office"="estate_agent"]', '["office"="insurance"]'] },
  { casa: /transportadora|transport/i, seletores: ['["office"="logistics"]', '["amenity"="parking"]'] },
  { casa: /cafe|cafeteria|sorveteria|acai/i, seletores: ['["amenity"="cafe"]', '["amenity"="ice_cream"]'] },
  { casa: /bar|pub/i, seletores: ['["amenity"="bar"]', '["amenity"="pub"]'] },
];

export function seletoresPara(categoria: string): { seletores: string[]; aproximado: boolean } {
  // /i não dobra acento ("farmácia" ≠ "farmacia"): normaliza antes de casar,
  // senão metade do português cai no fallback textual.
  const plano = categoria
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  for (const m of MAPA_CATEGORIAS) {
    if (m.casa.test(plano)) return { seletores: m.seletores, aproximado: false };
  }
  return { seletores: [], aproximado: true };
}

async function dormir(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class OSMOverpassProvider implements BusinessDiscoveryProvider {
  readonly nome = "osm_overpass";
  private overpassUrl: string;
  private timeoutMs: number;
  private tentativas: number;

  constructor(opts?: { overpassUrl?: string; timeoutMs?: number; tentativas?: number }) {
    this.overpassUrl = opts?.overpassUrl?.trim() || process.env.OSM_OVERPASS_URL?.trim() || OVERPASS_PADRAO;
    this.timeoutMs = opts?.timeoutMs ?? 60000;
    this.tentativas = opts?.tentativas ?? 3;
  }

  private async chamar<T>(corpo: string, tentativa = 1, espelho = 0): Promise<T> {
    const urls = [this.overpassUrl, ...ESPELHOS_RESERVA.filter((u) => u !== this.overpassUrl)];
    const url = urls[Math.min(espelho, urls.length - 1)] ?? urls[0]!;
    const controle = new AbortController();
    const limite = setTimeout(() => controle.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "User-Agent": UA,
          Accept: "application/json",
        },
        body: `data=${encodeURIComponent(corpo)}`,
        signal: controle.signal,
      });
    } catch (e) {
      // Rede caiu no meio: tenta o próximo espelho antes de desistir.
      if (espelho + 1 < urls.length) return this.chamar<T>(corpo, tentativa, espelho + 1);
      throw e;
    } finally {
      clearTimeout(limite);
    }
    if ((res.status === 429 || res.status >= 500 || res.status === 406) && tentativa < this.tentativas) {
      // Instância pública pede calma (ou bloqueia o egresso): backoff longo,
      // e no 406 pula direto para o próximo espelho.
      if (res.status === 406 && espelho + 1 < urls.length) {
        return this.chamar<T>(corpo, tentativa, espelho + 1);
      }
      await dormir(5000 * tentativa + Math.random() * 2000);
      return this.chamar<T>(corpo, tentativa + 1, espelho);
    }
    if (!res.ok) {
      const texto = await res.text().catch(() => "");
      throw new Error(`overpass_${res.status}: ${texto.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  }

  async geocodificar(consulta: string): Promise<{ latitude: number; longitude: number } | null> {
    const controle = new AbortController();
    const limite = setTimeout(() => controle.abort(), 15000);
    try {
      // Nominatim exige identificação honesta (política de uso): quem somos.
      const res = await fetch(
        `${NOMINATIM_PADRAO}?q=${encodeURIComponent(consulta)}&format=json&limit=1&countrycodes=br`,
        {
          headers: { Referer: "https://deskcommcrm.local/prospeccao", "User-Agent": "DeskcommCRM-Prospeccao/1.0" },
          signal: controle.signal,
        },
      );
      if (!res.ok) return null;
      const j = (await res.json()) as { lat?: string; lon?: string }[];
      const p = j?.[0];
      if (!p?.lat || !p?.lon) return null;
      return { latitude: Number(p.lat), longitude: Number(p.lon) };
    } catch {
      return null;
    } finally {
      clearTimeout(limite);
    }
  }

  async search(params: BusinessSearchParams): Promise<BusinessSearchResult> {
    // Bbox da célula a partir de centro + raio (graus locais, ver grade.ts).
    const rKm = params.raioMetros / 1000;
    const dLat = rKm / 110.574;
    const dLng = rKm / (111.32 * Math.cos((params.latitude * Math.PI) / 180));
    const sul = params.latitude - dLat;
    const norte = params.latitude + dLat;
    const oeste = params.longitude - dLng;
    const leste = params.longitude + dLng;
    const bbox = `${sul.toFixed(5)},${oeste.toFixed(5)},${norte.toFixed(5)},${leste.toFixed(5)}`;

    const { seletores } = seletoresPara(params.categoria);
    // Sem mapeamento: busca textual por nome na bbox (recall menor, honesto).
    const filtros =
      seletores.length > 0
        ? seletores.map((s) => `nwr${s}(${bbox});`).join("\n  ")
        : `nwr["name"~"${params.categoria.replace(/"/g, "")}",i](${bbox});`;

    const ql = `[out:json][timeout:50];(\n  ${filtros}\n);out center tags ${params.limite};`;
    const res = await this.chamar<{ elements?: Record<string, unknown>[] }>(ql);

    const negocios = ((res.elements ?? []) as unknown as {
      type?: string;
      id?: number;
      lat?: number;
      lon?: number;
      center?: { lat?: number; lon?: number };
      tags?: Record<string, string>;
    }[])
      .filter((e) => e.tags?.name)
      .slice(0, params.limite)
      .map((e) => {
        const tags = e.tags ?? {};
        const lat = e.lat ?? e.center?.lat ?? null;
        const lng = e.lon ?? e.center?.lon ?? null;
        const fone = tags["contact:phone"] ?? tags.phone ?? null;
        const site = tags["contact:website"] ?? tags.website ?? null;
        const rua = [tags["addr:street"], tags["addr:housenumber"]].filter(Boolean).join(", ") || null;
        const endereco = [rua, tags["addr:suburb"], tags["addr:city"], tags["addr:state"], tags["addr:postcode"]]
          .filter(Boolean)
          .join(", ") || null;
        return {
          idExterno: `osm:${e.type ?? "node"}/${e.id ?? ""}`,
          nome: tags.name ?? "",
          categoriaPrincipal: params.categoria,
          categoriasSecundarias: [] as string[],
          telefone: fone,
          website: site,
          email: tags["contact:email"] ?? tags.email ?? null,
          endereco,
          bairro: tags["addr:suburb"] ?? null,
          cidade: tags["addr:city"] ?? null,
          estado: tags["addr:state"] ?? null,
          cep: tags["addr:postcode"] ?? null,
          pais: "BR",
          latitude: lat,
          longitude: lng,
          urlExterna: lat !== null && lng !== null ? `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=17/${lat}/${lng}` : null,
          nota: null,
          totalAvaliacoes: 0,
          horarioFuncionamento: tags.opening_hours ? { texto: tags.opening_hours } : null,
        };
      });

    return { negocios, proximaPaginaToken: null, requisicoes: 1, detalhes: 0 };
  }

  async getDetails(_idExterno: string): Promise<BusinessDetails | null> {
    // Overpass já devolve tudo numa ida só — Details separado não existe
    // aqui, e inventar chamada extra seria custo fantasma no relatório.
    return null;
  }
}
