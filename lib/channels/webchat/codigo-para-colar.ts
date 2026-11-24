/**
 * O texto que a tela de quem administra mostra e que o cliente cola no próprio site (spec 36, F2).
 *
 * A chave `wck_` não é segredo (está no código-fonte do site), mas é conferida aqui com a mesma
 * régua da geração: qualquer coisa fora dela recusa, e quem chama mostra mensagem em vez de
 * montar um código quebrado ou com marcação injetada.
 */

// Só TIPOS vêm do `config.ts` (somem na compilação). Este arquivo roda no navegador, dentro da aba
// de Conexões, e o `config.ts` puxa `@/lib/env` (variáveis do servidor): um import de VALOR dali
// derruba a tela inteira com "Algo deu errado". O teste do arquivo vigia isso.
import type { FormatoDoChat, PosicaoDoChat } from "./config";

const FORMATO_PADRAO = "bolha";
const POSICAO_PADRAO = "direita";

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
const FORMATOS_ACEITOS: readonly string[] = ["bolha", "painel", "embutido", "pagina"];
const POSICOES_ACEITAS: readonly string[] = ["direita", "esquerda"];

function parametrosParaUrl(parametros?: {
  formato?: FormatoDoChat;
  posicao?: PosicaoDoChat;
}): string {
  const formato: string | undefined = parametros?.formato;
  const posicao: string | undefined = parametros?.posicao;
  const partes: string[] = [];
  if (formato !== undefined && formato !== FORMATO_PADRAO) {
    if (!FORMATOS_ACEITOS.includes(formato)) throw new Error("formato_invalido");
    partes.push(`&f=${encodeURIComponent(formato)}`);
  }
  if (posicao !== undefined && posicao !== POSICAO_PADRAO) {
    if (!POSICOES_ACEITAS.includes(posicao)) throw new Error("posicao_invalida");
    partes.push(`&p=${encodeURIComponent(posicao)}`);
  }
  // Já vem com o `&` na frente: o endereço do script sempre começa por `?k=<chave>`.
  return partes.join("");
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
