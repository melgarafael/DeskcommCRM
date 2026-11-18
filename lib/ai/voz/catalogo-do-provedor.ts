/**
 * O CATÁLOGO DE VOZES DO PROVEDOR — nome e idioma, e a queda para a lista que
 * já existe (#4260, item 2).
 *
 * Até aqui a tela só conhecia `ai_provider_credentials.models_available`, que o
 * validador grava como uma lista de `voice_id` crus (`provider-validators.ts`):
 * sem nome, sem idioma, e congelada na data da validação. Quem tem vozes
 * próprias/contratadas na conta ElevenLabs não as via.
 *
 * A listagem ao vivo (`/v1/voices`) resolve o "quem é quem", mas é uma chamada
 * EXTERNA no caminho de um GET de tela: se a ElevenLabs demorar, estiver fora
 * ou a chave não permitir listagem, a tela não pode ficar pior do que estava.
 * Daí `montarCatalogoDeVozes`: sucesso → catálogo do provedor; qualquer falha,
 * resposta vazia ou tempo esgotado → os ids que já estavam no banco, sem erro.
 */
export interface VozDoProvedor {
  id: string;
  /** Nome de exibição; na queda para a lista antiga é o próprio id (não há nome). */
  nome: string;
  /**
   * Idioma declarado pela voz, quando o provedor declara. A ElevenLabs não tem
   * um campo único e garantido para isto: `labels.language` aparece nas vozes
   * da biblioteca e `verified_languages` nas verificadas. `null` é resposta
   * honesta — melhor do que inventar "Português" para toda voz.
   */
  idioma: string | null;
}

export interface RespostaDeVozes {
  voices?: Array<{
    voice_id?: string;
    name?: string;
    labels?: Record<string, unknown> | null;
    verified_languages?: Array<{ language?: string }> | null;
  }>;
}

/** Tempo máximo da listagem: é um extra da tela, não pode segurar o GET. */
export const TEMPO_MAXIMO_DO_CATALOGO_MS = 3500;

export const URL_DAS_VOZES_DA_ELEVENLABS = "https://api.elevenlabs.io/v1/voices";

function idiomaDaVoz(voz: NonNullable<RespostaDeVozes["voices"]>[number]): string | null {
  const rotulo = voz.labels?.language;
  if (typeof rotulo === "string" && rotulo.trim() !== "") return rotulo.trim();
  const verificada = voz.verified_languages?.find((l) => typeof l?.language === "string" && l.language.trim() !== "");
  return verificada?.language?.trim() || null;
}

/**
 * Traduz a resposta do provedor no catálogo da tela. Puro de propósito: o
 * formato do `/v1/voices` já mudou de detalhe entre versões, e um teste com
 * fixture prova o mapeamento sem rede.
 */
export function lerVozesDaResposta(json: unknown): VozDoProvedor[] {
  const vozes = (json as RespostaDeVozes | null)?.voices;
  if (!Array.isArray(vozes)) return [];
  const vistas = new Set<string>();
  const catalogo: VozDoProvedor[] = [];
  for (const voz of vozes) {
    const id = typeof voz?.voice_id === "string" ? voz.voice_id.trim() : "";
    if (id === "" || vistas.has(id)) continue;
    vistas.add(id);
    const nome = typeof voz?.name === "string" && voz.name.trim() !== "" ? voz.name.trim() : id;
    catalogo.push({ id, nome, idioma: idiomaDaVoz(voz) });
  }
  return catalogo;
}

/** Busca as vozes da conta. Lança em erro de rede/HTTP — quem chama decide a queda. */
export async function listarVozesDoProvedor(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  tempoMaximoMs: number = TEMPO_MAXIMO_DO_CATALOGO_MS,
): Promise<VozDoProvedor[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), tempoMaximoMs);
  try {
    const res = await fetchImpl(URL_DAS_VOZES_DA_ELEVENLABS, {
      method: "GET",
      headers: { "xi-api-key": apiKey },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`voices_${res.status}`);
    return lerVozesDaResposta(await res.json());
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Catálogo da tela com a queda embutida.
 *
 * `buscar` é injetado para o teste conseguir simular a ElevenLabs fora do ar
 * sem dublê de módulo; a rota passa `() => listarVozesDoProvedor(chave)`.
 * O contrato é sempre o mesmo objeto: nunca lança, e `veioDoProvedor` diz de
 * onde veio a lista para a tela poder ser honesta sobre o que está mostrando.
 */
export async function montarCatalogoDeVozes(input: {
  idsDaCredencial: string[];
  buscar: () => Promise<VozDoProvedor[]>;
}): Promise<{ catalogo: VozDoProvedor[]; veioDoProvedor: boolean }> {
  try {
    const doProvedor = await input.buscar();
    if (doProvedor.length > 0) return { catalogo: doProvedor, veioDoProvedor: true };
  } catch {
    // Silêncio deliberado: falha de listagem é rotina (chave sem permissão de
    // leitura, provedor fora), e a resposta certa é a lista de antes — não um
    // erro que apaga o campo onde a pessoa ia colar o id.
  }
  const vistas = new Set<string>();
  const catalogo: VozDoProvedor[] = [];
  for (const id of input.idsDaCredencial) {
    if (typeof id !== "string" || id.trim() === "" || vistas.has(id)) continue;
    vistas.add(id);
    catalogo.push({ id, nome: id, idioma: null });
  }
  return { catalogo, veioDoProvedor: false };
}
