/**
 * GooglePlacesProvider — descoberta via Places API (New).
 *
 * Text Search por célula (`POST /v1/places:searchText`, até 20 por página,
 * até 3 páginas por célula) + Details sob demanda (só quando o enriquecimento
 * pedir — cada Details custa). Geocoding resolve "Cidade/UF" em coordenadas.
 *
 * Sem chave, o construtor LANÇA `sem_chave`: o worker marca a busca como
 * falha nomeando a tela de configuração, em vez de fazer 60 chamadas 403.
 * Cada chamada conta (requisicoes/detalhes) para o custo estimado da busca.
 */

import type {
  BusinessDetails,
  BusinessDiscoveryProvider,
  BusinessSearchParams,
  BusinessSearchResult,
  NegocioDescoberto,
} from "../tipos";

const BASE = "https://places.googleapis.com/v1";
const GEOCODE = "https://maps.googleapis.com/maps/api/geocode/json";

/** Estimativas em centavos de BRL (Places AT 2025; reajuste = trocar aqui). */
export const CUSTO_SEARCH_CENTS = 18;
export const CUSTO_DETAILS_CENTS = 11;

export interface Geocodificado {
  latitude: number;
  longitude: number;
  enderecoFormatado: string;
}

async function dormir(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class GooglePlacesProvider implements BusinessDiscoveryProvider {
  readonly nome = "google_places";
  private chave: string;
  private timeoutMs: number;
  private tentativas: number;

  constructor(chave: string, opts?: { timeoutMs?: number; tentativas?: number }) {
    if (!chave || !chave.trim()) {
      throw new Error("sem_chave: configure GOOGLE_MAPS_API_KEY (Configurações → Prospecção).");
    }
    this.chave = chave.trim();
    this.timeoutMs = opts?.timeoutMs ?? 15000;
    this.tentativas = opts?.tentativas ?? 3;
  }

  private async chamar<T>(url: string, init: RequestInit, tentativa = 1): Promise<T> {
    const controle = new AbortController();
    const limite = setTimeout(() => controle.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: controle.signal });
      if ((res.status === 429 || res.status >= 500) && tentativa < this.tentativas) {
        // Backoff exponencial com jitter: 429/5xx do Google pede calma, não força.
        await dormir(1000 * 2 ** (tentativa - 1) + Math.random() * 500);
        return this.chamar<T>(url, init, tentativa + 1);
      }
      if (!res.ok) {
        const corpo = await res.text().catch(() => "");
        throw new Error(`google_${res.status}: ${corpo.slice(0, 300)}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(limite);
    }
  }

  async geocodificar(consulta: string): Promise<Geocodificado | null> {
    const url = `${GEOCODE}?address=${encodeURIComponent(consulta)}&region=br&key=${encodeURIComponent(this.chave)}`;
    const res = await this.chamar<{ status: string; results: { geometry: { location: { lat: number; lng: number } }; formatted_address: string }[] }>(
      url,
      { method: "GET" },
    );
    const primeiro = res.results?.[0];
    if (res.status !== "OK" || !primeiro) return null;
    return {
      latitude: primeiro.geometry.location.lat,
      longitude: primeiro.geometry.location.lng,
      enderecoFormatado: primeiro.formatted_address,
    };
  }

  async search(params: BusinessSearchParams): Promise<BusinessSearchResult> {
    const negocios: NegocioDescoberto[] = [];
    let requisicoes = 0;
    let paginaToken: string | null | undefined = params.paginaToken ?? null;

    // Text Search devolve até 20 por página e o Google pagina no máximo 3x
    // por consulta — é exatamente por isso que a grade existe.
    for (let pagina = 0; pagina < 3; pagina++) {
      const corpo: Record<string, unknown> = {
        textQuery: params.categoria,
        languageCode: "pt-BR",
        regionCode: "BR",
        maxResultCount: Math.min(20, params.limite - negocios.length),
        locationBias: {
          circle: {
            center: { latitude: params.latitude, longitude: params.longitude },
            radius: params.raioMetros,
          },
        },
      };
      if (paginaToken) corpo.pageToken = paginaToken;

      const res = await this.chamar<{
        places?: {
          id: string;
          displayName?: { text?: string };
          formattedAddress?: string;
          nationalPhoneNumber?: string;
          internationalPhoneNumber?: string;
          websiteUri?: string;
          rating?: number;
          userRatingCount?: number;
          businessStatus?: string;
          types?: string[];
          location?: { latitude?: number; longitude?: number };
          regularOpeningHours?: Record<string, unknown>;
        }[];
        nextPageToken?: string;
      }>(`${BASE}/places:searchText`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": this.chave,
          "X-Goog-FieldMask":
            "places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber," +
            "places.internationalPhoneNumber,places.websiteUri,places.rating,places.userRatingCount," +
            "places.businessStatus,places.types,places.location,places.regularOpeningHours,nextPageToken",
        },
        body: JSON.stringify(corpo),
      });
      requisicoes++;

      for (const p of res.places ?? []) {
        negocios.push({
          idExterno: p.id,
          nome: p.displayName?.text ?? "",
          categoriaPrincipal: p.types?.[0] ?? null,
          categoriasSecundarias: (p.types ?? []).slice(1),
          telefone: p.internationalPhoneNumber ?? p.nationalPhoneNumber ?? null,
          website: p.websiteUri ?? null,
          email: null,
          endereco: p.formattedAddress ?? null,
          bairro: null,
          cidade: null,
          estado: null,
          cep: null,
          pais: "BR",
          latitude: p.location?.latitude ?? null,
          longitude: p.location?.longitude ?? null,
          urlExterna: `https://www.google.com/maps/search/?api=1&query_place_id=${p.id}`,
          nota: p.rating ?? null,
          totalAvaliacoes: p.userRatingCount ?? 0,
          horarioFuncionamento: (p.regularOpeningHours as Record<string, unknown> | undefined) ?? null,
        });
        if (negocios.length >= params.limite) break;
      }

      paginaToken = res.nextPageToken ?? null;
      // Token novo precisa de ~2s para ativar no Google; sem a pausa, a
      // página seguinte volta vazia e a coleta "termina" cedo, em silêncio.
      if (paginaToken && negocios.length < params.limite) {
        await dormir(2000);
      } else {
        break;
      }
    }

    return { negocios, proximaPaginaToken: paginaToken, requisicoes, detalhes: 0 };
  }

  async getDetails(idExterno: string): Promise<BusinessDetails | null> {
    const res = await this.chamar<{
      id?: string;
      displayName?: { text?: string };
      formattedAddress?: string;
      nationalPhoneNumber?: string;
      internationalPhoneNumber?: string;
      websiteUri?: string;
      rating?: number;
      userRatingCount?: number;
      businessStatus?: string;
      types?: string[];
      location?: { latitude?: number; longitude?: number };
      regularOpeningHours?: Record<string, unknown>;
    }>(
      `${BASE}/places/${encodeURIComponent(idExterno)}`,
      {
        method: "GET",
        headers: {
          "X-Goog-Api-Key": this.chave,
          "X-Goog-FieldMask":
            "id,displayName,formattedAddress,nationalPhoneNumber,internationalPhoneNumber," +
            "websiteUri,rating,userRatingCount,businessStatus,types,location,regularOpeningHours",
        },
      },
    );
    if (!res.id) return null;
    return {
      idExterno: res.id,
      nome: res.displayName?.text ?? "",
      categoriaPrincipal: res.types?.[0] ?? null,
      categoriasSecundarias: (res.types ?? []).slice(1),
      telefone: res.internationalPhoneNumber ?? res.nationalPhoneNumber ?? null,
      website: res.websiteUri ?? null,
      email: null,
      endereco: res.formattedAddress ?? null,
      bairro: null,
      cidade: null,
      estado: null,
      cep: null,
      pais: "BR",
      latitude: res.location?.latitude ?? null,
      longitude: res.location?.longitude ?? null,
      urlExterna: `https://www.google.com/maps/search/?api=1&query_place_id=${res.id}`,
      nota: res.rating ?? null,
      totalAvaliacoes: res.userRatingCount ?? 0,
      horarioFuncionamento: (res.regularOpeningHours as Record<string, unknown> | undefined) ?? null,
    };
  }
}
