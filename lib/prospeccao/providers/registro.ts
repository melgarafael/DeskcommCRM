/**
 * O REGISTRO — um mapa nome → fábrica. O job, as rotas e a tela falam com
 * nomes ("google_places"), nunca com classes. Provider novo = 1 entrada aqui
 * + metadados; nada mais precisa saber que ele existe.
 */

import { GooglePlacesProvider } from "./google-places";
import { MapsBrowserProvider } from "./browser";
import { OSMOverpassProvider } from "./osm";
import type { BusinessDiscoveryProvider } from "../tipos";

export const PROVIDERS_CONHECIDOS = ["google_places", "osm_overpass", "maps_browser"] as const;
export type NomeDeProvider = (typeof PROVIDERS_CONHECIDOS)[number];

export interface OpcoesDeProvider {
  chaveGoogle?: string;
  browserHabilitado?: boolean;
  timeoutMs?: number;
  tentativas?: number;
}

export function criarProvider(nome: string, opts: OpcoesDeProvider = {}): BusinessDiscoveryProvider {
  switch (nome) {
    case "google_places":
      return new GooglePlacesProvider(opts.chaveGoogle ?? "", {
        timeoutMs: opts.timeoutMs,
        tentativas: opts.tentativas,
      });
    case "osm_overpass":
      return new OSMOverpassProvider({ timeoutMs: opts.timeoutMs, tentativas: opts.tentativas });
    case "maps_browser":
      return new MapsBrowserProvider(opts.browserHabilitado ?? false);
    default:
      throw new Error(`provider_desconhecido: "${nome}". Conhecidos: ${PROVIDERS_CONHECIDOS.join(", ")}.`);
  }
}

/** Metadados para a tela (seletor de provider) — sem segredo aqui. */
export const METADADOS_PROVIDERS: { nome: NomeDeProvider; rotulo: string; descricao: string }[] = [
  {
    nome: "google_places",
    rotulo: "Google Places (API oficial)",
    descricao: "Busca oficial por texto + detalhes. Requer chave com faturamento. Custo por consulta.",
  },
  {
    nome: "osm_overpass",
    rotulo: "OpenStreetMap (grátis)",
    descricao: "Diretório aberto, sem chave e sem custo. Nome, endereço e mapa; telefone/site quando cadastrados, sem avaliações. Cobertura varia por cidade.",
  },
  {
    nome: "maps_browser",
    rotulo: "Navegador (desligado)",
    descricao: "Coleta via navegador automatizado — esqueleto. Requer implementação e respeita bloqueios do fornecedor.",
  },
];
