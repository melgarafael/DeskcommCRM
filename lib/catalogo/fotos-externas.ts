/**
 * Fotos de produto que são LINK EXTERNO (Meta, Nuvemshop…) → arquivo no nosso
 * bucket `catalog-photos`.
 *
 * Por que: o atendente de IA só envia foto que está no bucket
 * (`lib/agent-engine/agent/fotos-do-produto.ts` filtra por
 * `fotoPertenceAoProduto`), e a tela só mostra prévia de foto assinada. Um
 * catálogo importado da Meta vinha inteiro em links — medido na Turbo Kids em
 * out/2026: 443 produtos, nenhuma foto enviável, toda prévia "Sem prévia".
 *
 * As mesmas réguas da subida manual (`app/api/v1/products/[id]/fotos`): até
 * 5 MB, JPG ou PNG pelo conteúdo (não pela extensão), caminho
 * `org/produto/<uuid>.<ext>`.
 *
 * O uuid é DERIVADO do link (hash), não aleatório: a mesma foto baixada duas
 * vezes cai no mesmo arquivo, e a reimportação reconhece a foto que já foi
 * trazida em vez de repeti-la na galeria.
 */
import { createHash } from "node:crypto";

import { extensaoDe, farejarTipo, MAXIMO_DE_FOTOS, TAMANHO_MAXIMO_DA_FOTO } from "@/lib/catalogo/fotos";

export function ehFotoExterna(foto: string): boolean {
  return /^https?:\/\//i.test(foto.trim());
}

/** uuid estável por link (formato 8-4-4-4-12 em hex, o que `fotoPertenceAoProduto` aceita). */
export function uuidDaFotoExterna(url: string): string {
  const h = createHash("sha256").update(url.trim()).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function jaTrazida(fotos: readonly string[], url: string): boolean {
  const uuid = uuidDaFotoExterna(url);
  return fotos.some((f) => f.endsWith(`/${uuid}.jpg`) || f.endsWith(`/${uuid}.png`));
}

export interface DepsDasFotos {
  /** Os bytes do link, ou `null` quando não deu para baixar. */
  baixar(url: string): Promise<Uint8Array | null>;
  /** Grava no bucket; `true` quando gravou. */
  subir(caminho: string, bytes: Uint8Array, tipo: "image/png" | "image/jpeg"): Promise<boolean>;
}

export interface FotosTrazidas {
  fotos: string[];
  baixadas: number;
  falhas: number;
}

/**
 * Troca cada link pela foto no bucket, NA MESMA POSIÇÃO (a primeira continua
 * sendo a capa). Link que falhar fica como está — nada se perde, e a próxima
 * tentativa pega de novo. Link de foto já trazida sai da lista.
 */
export async function trazerFotosParaOArmazenamento(
  deps: DepsDasFotos,
  alvo: { orgId: string; produtoId: string; fotos: readonly string[] },
): Promise<FotosTrazidas> {
  const resultado: string[] = [];
  let baixadas = 0;
  let falhas = 0;
  for (const foto of alvo.fotos) {
    if (!ehFotoExterna(foto)) {
      if (!resultado.includes(foto)) resultado.push(foto);
      continue;
    }
    if (jaTrazida(alvo.fotos, foto) || jaTrazida(resultado, foto)) continue;
    const bytes = await deps.baixar(foto.trim());
    const tipo = bytes && bytes.length <= TAMANHO_MAXIMO_DA_FOTO ? farejarTipo(bytes) : null;
    if (!bytes || !tipo) {
      falhas++;
      resultado.push(foto);
      continue;
    }
    const caminho = `${alvo.orgId}/${alvo.produtoId}/${uuidDaFotoExterna(foto)}.${extensaoDe(tipo)}`;
    if (await deps.subir(caminho, bytes, tipo)) {
      baixadas++;
      resultado.push(caminho);
    } else {
      falhas++;
      resultado.push(foto);
    }
  }
  return { fotos: resultado.slice(0, MAXIMO_DE_FOTOS), baixadas, falhas };
}
