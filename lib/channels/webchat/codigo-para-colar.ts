/**
 * O texto que a tela de quem administra mostra e que o cliente cola no próprio site (spec 36, F2).
 *
 * A chave `wck_` não é segredo (está no código-fonte do site), mas é conferida aqui com a mesma
 * régua da geração: qualquer coisa fora dela recusa, e quem chama mostra mensagem em vez de
 * montar um código quebrado ou com marcação injetada.
 */

import { FORMATO_PADRAO, POSICAO_PADRAO, type FormatoDoChat, type PosicaoDoChat } from "./config";

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

/**
 * Parâmetros opcionais de formato e posição, só o que difere do padrão.
 * Valores são conferidos contra as listas (outro valor = erro).
 */
function parametrosParaUrl(parametros?: {
  formato?: FormatoDoChat;
  posicao?: PosicaoDoChat;
}): string {
  const partes: string[] = [];
  if (parametros?.formato && parametros.formato !== FORMATO_PADRAO) {
    if (!["bolha", "painel", "embutido", "pagina"].includes(parametros.formato)) {
      throw new Error("formato_invalido");
    }
    partes.push(`f=${encodeURIComponent(parametros.formato)}`);
  }
  if (parametros?.posicao && parametros.posicao !== POSICAO_PADRAO) {
    if (parametros.posicao !== "direita" && parametros.posicao !== "esquerda") {
      throw new Error("posicao_invalida");
    }
    partes.push(`p=${encodeURIComponent(parametros.posicao)}`);
  }
  return partes.length ? `?${partes.join("&")}` : "";
}

/** A linha que o cliente cola no site: carrega o widget com a chave dele. */
export function codigoParaColar(
  origemDoCrm: string,
  chave: string,
  parametros?: { formato?: FormatoDoChat; posicao?: PosicaoDoChat },
): string {
  const origem = origemLimpa(origemDoCrm);
  const parametrosUrl = parametrosParaUrl(parametros);
  const script = `<script src="${origem}/webchat.js?k=${chaveConferida(chave)}${parametrosUrl}" async></script>`;

  if (parametros?.formato === "embutido") {
    // Embutido: o iframe vive dentro de um elemento marcado pelo site.
    return `<div id="webchat-aqui"></div>\n${script.replace(' async>', ' data-webchat-alvo="#webchat-aqui" async>')}`;
  }

  return script;
}

/** Endereço que abre a conversa numa página própria, sem o site do cliente. */
export function linkDireto(origemDoCrm: string, chave: string): string {
  const origem = origemLimpa(origemDoCrm);
  return `${origem}/chat/${chaveConferida(chave)}`;
}
