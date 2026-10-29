/** Configuração da fotografia: idioma real da conta, controles nativos e saída separados. */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { DICIONARIO, traduzir } from "../lib/i18n/dicionario";
import type { Alvo } from "./licao";

import { idiomaDaCaptura } from "./configuracao";
export { idiomaDaCaptura, pastaDaSaida, commitDaFoto, type IdiomaDaCaptura } from "./configuracao";
const raiz = path.dirname(new URL(import.meta.url).pathname);

function catalogo(nome: string): Record<string, string> {
  const arquivo = path.join(raiz, nome);
  return existsSync(arquivo)
    ? (JSON.parse(readFileSync(arquivo, "utf8")) as Record<string, string>)
    : {};
}
const alvosEs = catalogo("espanhol-alvos.json");
const dadosEs = catalogo("espanhol-demonstracao.json");

/** Dados semeados só mudam se têm entrada explícita. Nomes, códigos e ids continuam intactos. */
export function textoDaInterface(texto: string): string {
  if (idiomaDaCaptura() === "pt-BR") return texto;
  const daTela = traduzir(texto, "es");
  return daTela === texto ? (dadosEs[texto] ?? texto) : daTela;
}

export function textoDoAlvo(texto: string, regex = false): string {
  if (idiomaDaCaptura() === "pt-BR") return texto;
  if (alvosEs[texto]) return alvosEs[texto];
  if (!regex) return textoDaInterface(texto);
  const inicio = texto.startsWith("^") ? "^" : "";
  const fim = texto.endsWith("$") ? "$" : "";
  const miolo = texto.slice(inicio.length, fim ? -1 : undefined);
  const traduzido = textoDaInterface(miolo);
  return traduzido === miolo
    ? texto
    : inicio + traduzido.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + fim;
}

/** Um trecho de mensagem identifica o texto completo conhecido da semente.
 * Sem correspondência única não inventa prefixo: o alvo falha para revisão.
 */
function trechoDaDemonstracao(texto: string): string {
  const direto = textoDoAlvo(texto);
  if (
    direto !== texto ||
    idiomaDaCaptura() === "pt-BR" ||
    Object.hasOwn(dadosEs, texto) ||
    Object.hasOwn(DICIONARIO, texto) ||
    texto.length < 8
  )
    return direto;
  const encontrados = [
    ...new Set(
      Object.entries(dadosEs)
        .filter(([pt]) => pt.includes(texto))
        .map(([, es]) => es),
    ),
  ];
  return encontrados.length === 1 ? encontrados[0]! : direto;
}

export function seletorNoIdioma(css: string): string {
  if (idiomaDaCaptura() === "pt-BR") return css;
  return css
    .replace(
      /(:text-matches\(\s*)(["'])(.*?)\2/g,
      (_, antes: string, aspas: string, texto: string) =>
        antes + aspas + textoDoAlvo(texto, true) + aspas,
    )
    .replace(
      /(:(?:has-text|text-is|text)\(\s*)(["'])(.*?)\2(\s*\))/g,
      (_, antes: string, aspas: string, texto: string, depois: string) =>
        antes + aspas + trechoDaDemonstracao(texto) + aspas + depois,
    )
    .replace(
      /(\[(?:aria-label|title|placeholder)(?:[~|^$*])?=)(["'])(.*?)\2\]/g,
      (_, antes: string, aspas: string, texto: string) =>
        antes + aspas + textoDoAlvo(texto) + aspas + "]",
    );
}

export function alvoNoIdioma<T extends Alvo>(alvo: T): T {
  if (alvo.literal) {
    return { ...alvo, ...(alvo.dentro ? { dentro: alvoNoIdioma(alvo.dentro) } : {}) };
  }
  return {
    ...alvo,
    ...(alvo.nome !== undefined ? { nome: textoDoAlvo(alvo.nome, alvo.regex) } : {}),
    ...(alvo.texto !== undefined ? { texto: textoDoAlvo(alvo.texto, alvo.regex) } : {}),
    ...(alvo.rotulo !== undefined ? { rotulo: textoDoAlvo(alvo.rotulo) } : {}),
    ...(alvo.placeholder !== undefined ? { placeholder: textoDoAlvo(alvo.placeholder) } : {}),
    ...(alvo.css !== undefined ? { css: seletorNoIdioma(alvo.css) } : {}),
    ...(alvo.dentro ? { dentro: alvoNoIdioma(alvo.dentro) } : {}),
  };
}
