import type { ExtensionCatalog } from "./manifest";

/**
 * O endereço do serviço de um módulo conectado, lido da ENTRADA do catálogo admitido.
 *
 * O pacote não tem URL (ADR-0003, D3): quem sabe onde o serviço fica é o catálogo revisado. Quem
 * chama (F2 e F4, e a admissão) recebe `null` quando a entrada não tem `service_origin` ou quando a
 * entrada não existe, e decide o que fazer com isso; esta função nunca inventa um endereço.
 */
export function servicoDoModulo(
  snapshot: ExtensionCatalog,
  publisher: string,
  name: string,
  version: string,
): string | null {
  const entrada = snapshot.entries.find(
    (entry) => entry.publisher === publisher && entry.name === name && entry.version === version,
  );
  return entrada?.service_origin ?? null;
}
