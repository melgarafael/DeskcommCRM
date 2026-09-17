/**
 * O nome com que a organização aparece no WaCalls — e o vínculo que o relay do
 * pareamento usa para reconhecer a própria sessão ANTES de o banco saber o id.
 *
 * `POST /api/sessions` do upstream já inicia o pareamento por dentro
 * (`Manager.Create` → `startPairing`), e o primeiro QR sai na `/api/events`
 * enquanto a resposta HTTP com o `id` ainda está a caminho. Quem filtra o
 * relay só pelo id gravado em `channel_sessions` perde esse QR por construção.
 * O broker, porém, emite `session-list` (com `name`) na criação e antes de
 * cada QR — então o nome é a chave que existe no instante certo. Uma função
 * só, para a rota que cria e o relay que escuta nunca divergirem.
 *
 * O uuid INTEIRO, e não os 8 primeiros caracteres: o nome é a chave pela qual
 * o relay aceita QR e "pareado", e dois tenants com o mesmo prefixo de 32 bits
 * receberiam o QR um do outro. Sessões antigas (`org_XXXXXXXX`) seguem
 * reconhecidas pelo id gravado em `channel_sessions`, nunca pelo nome.
 */
export function nomeDaSessaoDeVoz(organizationId: string): string {
  return `org_${organizationId}`;
}
