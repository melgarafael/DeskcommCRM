/**
 * O CONTRATO DOS PROVIDERS DE DESCOBERTA — a fronteira isolada (§1 do plano).
 *
 * Todo código específico de fornecedor (Google, browser, futuros) mora ATRÁS
 * desta interface. O resto do app (grade, normalização, dedup, job, tela)
 * nunca importa nada de provider concreto — só estes tipos e o registro em
 * `lib/prospeccao/providers/registro.ts`.
 */

export interface BusinessSearchParams {
  /** "Oficina mecânica" — o termo que vai ao provider. */
  categoria: string;
  latitude: number;
  longitude: number;
  /** Raio da célula em metros (o grid quebra a região em células). */
  raioMetros: number;
  /** Teto de resultados desta célula (paginação do provider). */
  limite: number;
  /** Token opaco de paginação do provider (volta na próxima chamada). */
  paginaToken?: string | null;
}

export interface NegocioDescoberto {
  /** ID no provider (place_id, hash da URL...). NULL quando não há. */
  idExterno: string | null;
  nome: string;
  categoriaPrincipal: string | null;
  categoriasSecundarias: string[];
  telefone: string | null;
  website: string | null;
  email: string | null;
  endereco: string | null;
  bairro: string | null;
  cidade: string | null;
  estado: string | null;
  cep: string | null;
  pais: string | null;
  latitude: number | null;
  longitude: number | null;
  urlExterna: string | null;
  nota: number | null;
  totalAvaliacoes: number;
  horarioFuncionamento: Record<string, unknown> | null;
}

export interface BusinessSearchResult {
  negocios: NegocioDescoberto[];
  /** Mais páginas neste provider (o job continua com paginaToken). */
  proximaPaginaToken?: string | null;
  /** Contabilidade de custo (§29): o job soma no search. */
  requisicoes: number;
  detalhes: number;
}

export interface BusinessDetails extends NegocioDescoberto {
  idExterno: string;
}

export interface BusinessDiscoveryProvider {
  readonly nome: string;
  search(params: BusinessSearchParams): Promise<BusinessSearchResult>;
  getDetails(idExterno: string): Promise<BusinessDetails | null>;
  /** Opcional: quem sabe geocodificar resolve "Cidade/UF" sozinho. */
  geocodificar?(consulta: string): Promise<{ latitude: number; longitude: number } | null>;
}
