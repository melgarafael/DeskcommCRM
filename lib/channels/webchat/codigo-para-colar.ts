/**
 * O texto que a tela de quem administra mostra e que o cliente cola no próprio site (spec 36, F2).
 *
 * A chave `wck_` não é segredo (está no código-fonte do site), mas é conferida aqui com a mesma
 * régua da geração: qualquer coisa fora dela recusa, e quem chama mostra mensagem em vez de
 * montar um código quebrado ou com marcação injetada.
 */

const CHAVE_DO_CHAT = /^wck_[A-Za-z0-9_-]{1,64}$/;

/** Origem do CRM sem barra final. Só http(s): é o único esquema que um site consegue carregar. */
function origemLimpa(texto: string): string {
  const limpo = texto.trim().replace(/\/+$/, "");
  let endereco: URL;
  try {
    endereco = new URL(limpo);
  } catch {
    throw new Error("origem_invalida");
  }
  if (endereco.protocol !== "https:" && endereco.protocol !== "http:") {
    throw new Error("origem_invalida");
  }
  return endereco.origin;
}

function chaveConferida(chave: string): string {
  if (!CHAVE_DO_CHAT.test(chave)) throw new Error("chave_invalida");
  return encodeURIComponent(chave);
}

/** A linha que o cliente cola no site: carrega o widget com a chave dele. */
export function codigoParaColar(origemDoCrm: string, chave: string): string {
  const origem = origemLimpa(origemDoCrm);
  return `<script src="${origem}/webchat.js?k=${chaveConferida(chave)}" async></script>`;
}

/** Endereço que abre a conversa numa página própria, sem o site do cliente. */
export function linkDireto(origemDoCrm: string, chave: string): string {
  const origem = origemLimpa(origemDoCrm);
  return `${origem}/chat/${chaveConferida(chave)}`;
}
