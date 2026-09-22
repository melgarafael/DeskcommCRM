/**
 * MapsBrowserProvider — ESQUELETO DESLIGADO (§3 do plano).
 *
 * Existe para o CONTRATO (mesma interface dos demais), não para coletar:
 * todo método lança `nao_implementado`, a menos que `MAPS_BROWSER_ENABLED=true`
 * E a implementação real seja ligada — e mesmo ligada, este arquivo continua
 * sendo só a casca: o motor Playwright mora em `workers/prospecting-browser/`
 * (fora do runtime web), isolado para desligar sem tocar no resto.
 *
 * Regras gravadas aqui para quem for implementar:
 * - NUNCA quebrar CAPTCHA, contornar controle de acesso ou burlar bloqueio.
 *   Bloqueio do fornecedor = erro registrado + tarefa reagendada/pausada.
 * - Timeout, retry com backoff, rate limit e checkpoint são obrigatórios —
 *   reutilize `lib/prospeccao/grade.ts` (células) e a tabela de buscas
 *   (progresso), nunca estado em memória.
 * - Seletores frágeis por último: prefira URLs de pesquisa + extração de
 *   dados estruturados (JSON-LD) quando disponíveis.
 */

import type {
  BusinessDetails,
  BusinessDiscoveryProvider,
  BusinessSearchParams,
  BusinessSearchResult,
} from "../tipos";

export class MapsBrowserProvider implements BusinessDiscoveryProvider {
  readonly nome = "maps_browser";
  private habilitado: boolean;

  constructor(habilitado = false) {
    this.habilitado = habilitado;
  }

  private exigir(): void {
    if (!this.habilitado) {
      throw new Error(
        "nao_implementado: provider via navegador desligado. " +
          "Ligue MAPS_BROWSER_ENABLED e implemente workers/prospecting-browser/ — o Google Places cobre enquanto isso.",
      );
    }
  }

  async search(_params: BusinessSearchParams): Promise<BusinessSearchResult> {
    this.exigir();
    // Implementação futura (ver cabeçalho): nunca retorne parcial silencioso.
    throw new Error("nao_implementado: motor Playwright ainda não ligado.");
  }

  async getDetails(_idExterno: string): Promise<BusinessDetails | null> {
    this.exigir();
    throw new Error("nao_implementado: motor Playwright ainda não ligado.");
  }
}
