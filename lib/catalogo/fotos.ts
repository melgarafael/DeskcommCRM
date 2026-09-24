/**
 * AS FOTOS DO PRODUTO — as regras que a rota, a tela e o agente compartilham.
 *
 * O banco guarda CAMINHOS em `catalog-photos` (migration 0390), na ordem da
 * tela; a primeira é a capa. Os números abaixo são os do bucket: um teto aqui
 * diferente do de lá faria a rota aceitar o que o Storage recusa, e o erro que
 * chegaria à tela seria "erro ao subir a foto".
 */

export const BUCKET_DAS_FOTOS = "catalog-photos";

/** O mesmo `cardinality(fotos) <= 5` do CHECK da 0390. */
export const MAXIMO_DE_FOTOS = 5;

/** 5 MB: o `file_size_limit` do bucket, e o teto de imagem do WhatsApp oficial. */
export const TAMANHO_MAXIMO_DA_FOTO = 5 * 1024 * 1024;

/**
 * O formato é decidido pela ASSINATURA dos bytes — `farejarTipo`, o mesmo
 * farejador do logo (`lib/branding/logo-arquivo.ts`), que aceita exatamente
 * JPEG e PNG. Não pelo `content-type` que o navegador declarou: esse é do
 * cliente, e o arquivo vai ser servido ao WhatsApp de outra pessoa.
 */
export { extensaoDe, farejarTipo } from "@/lib/branding/logo-arquivo";

const FORMA_DO_ARQUIVO = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png)$/;

/**
 * O caminho É desta organização e deste produto, na forma exata que a rota gera?
 *
 * ⚠️ Quem LÊ o caminho confere, não só quem escreve. A coluna é gravável pelo
 * PostgREST por qualquer `manager` da organização, e a leitura do arquivo é por
 * service role, que não tem RLS: sem esta conferência, um caminho de outra
 * organização gravado na linha viraria foto alheia assinada na tela ou enviada
 * pelo agente — ou, na remoção, arquivo alheio APAGADO pela rota (o mesmo
 * ataque que `podeApagar` fecha no logo).
 */
export function fotoPertenceAoProduto(caminho: string, orgId: string, produtoId: string): boolean {
  const prefixo = `${orgId}/${produtoId}/`;
  return caminho.startsWith(prefixo) && FORMA_DO_ARQUIVO.test(caminho.slice(prefixo.length));
}

export function mimeDaFoto(caminho: string): "image/png" | "image/jpeg" {
  return caminho.endsWith(".png") ? "image/png" : "image/jpeg";
}

/**
 * A nova ordem que a tela mandou: só reordena e remove, nunca acrescenta.
 *
 * Foto nova entra pelo upload, que é quem confere os bytes. Aceitar um caminho
 * novo aqui seria aceitar um arquivo que ninguém conferiu — ou o de outro
 * produto.
 */
export function conferirNovaOrdem(
  atual: readonly string[],
  nova: readonly string[],
): { ok: true; removidas: string[] } | { ok: false } {
  if (new Set(nova).size !== nova.length) return { ok: false };
  if (nova.some((c) => !atual.includes(c))) return { ok: false };
  return { ok: true, removidas: atual.filter((c) => !nova.includes(c)) };
}
