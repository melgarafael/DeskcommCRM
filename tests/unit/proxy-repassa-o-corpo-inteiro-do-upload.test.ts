import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";
import { MAX_MEDIA_BYTES } from "@/lib/messaging/media/types";

/**
 * O `proxy.ts` casa /api, e o Next só repassa à rota os primeiros
 * `proxyClientMaxBodySize` bytes do corpo (padrão: 10 MB). Abaixo do teto que
 * a rota de mídia lê (`MAX_MEDIA_BYTES + 1 MiB`), o anexo chega cortado e a
 * tela que promete 50 MB mente (#4422). Um teto futuro maior reabre o defeito
 * se este número não subir junto.
 */
describe("next.config — limite do corpo que o proxy repassa", () => {
  it("cobre o teto de mídia mais a folga do lerCorpoComTeto", () => {
    expect(nextConfig.experimental?.proxyClientMaxBodySize).toBeGreaterThanOrEqual(
      MAX_MEDIA_BYTES + 1_048_576,
    );
  });
});
