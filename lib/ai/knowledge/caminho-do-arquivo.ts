/**
 * `true` só para o formato que o upload e o texto colado gravam desde sempre:
 * `<orgId>/<uuid>.<ext>`. O download do acervo é com o admin client, que não
 * olha a pasta, então quem lê ou aceita um caminho confere o formato INTEIRO, e
 * não só o prefixo: um prefixo deixa passar `..`, `%2e` e barra invertida.
 *
 * Módulo sem dependência de propósito: os testes que dublam
 * `lib/ai/rag/ingest/documento` não podem levar esta regra junto.
 */
const NOME_DO_ARQUIVO =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{1,8}$/;

export function caminhoDaOrganizacao(caminho: unknown, organizationId: string): caminho is string {
  if (typeof caminho !== "string") return false;
  const partes = caminho.split("/");
  return partes.length === 2 && partes[0] === organizationId && NOME_DO_ARQUIVO.test(partes[1]!);
}
