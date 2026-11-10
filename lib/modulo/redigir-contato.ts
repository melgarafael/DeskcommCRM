/**
 * O CONTATO DENTRO DE OUTRA ÁREA (Spec 33, F3; ADR-0005 D4).
 *
 * O consentimento por área vale para o DADO que vem na resposta, e não só para a rota. Conversa, negócio e
 * agenda trazem o contato junto (nome, telefone, etiquetas, bloqueio). Um módulo que tem `conversas` e não
 * tem `contatos` (leitura) recebe só o `id` do contato, que é opaco, mais `redacted: true` (o módulo sabe que
 * o dado foi retirado); o resto sai da resposta, no servidor.
 *
 * TEXTO LIVRE. Campo digitado pela equipe (título do negócio, observação, descrição) pode trazer o nome, o
 * telefone ou o e-mail do contato. Dentro de cada registro que traz um contato, os identificadores DESSE contato
 * viram `[contato]` em todo valor string do registro e dos filhos dele (herança para baixo, nunca para irmãos:
 * num quadro, o contato do negócio A não filtra o título do negócio B). O objeto que teve texto trocado ganha
 * `text_redacted: true` (mesmo motivo do `redacted: true`). É filtro por LISTA, sem adivinhar:
 *   - nome: o nome inteiro e cada parte com 3+ letras, como palavra inteira, sem diferenciar maiúscula nem acento;
 *   - telefone: os últimos 8 dígitos com qualquer separador entre eles, mais o código do país e o DDD na frente;
 *   - e-mail: igual, sem diferenciar maiúscula.
 * Chave `id`, `*_id`, `redacted` e `text_redacted` nunca são filtradas.
 * LIMITE CONHECIDO: só sai o que está escrito igual ao cadastro. Apelido ("Cida" para "Aparecida") passa, e o
 * nome de OUTRA pessoa, que não seja o contato ligado ao registro, também passa.
 *
 * Sessão de navegador e token que não é de módulo não passam por aqui: veem tudo, como sempre viram.
 * LADO SEGURO: token de módulo SEM o campo `contatoVisivel` (nunca preenchido, teste que simula o
 * autorizador) é tratado como "não vê contato".
 *
 * A cerca `tests/unit/modulo-rota-com-contato-redige.test.ts` reprova rota que o módulo alcança, que
 * embute contato na resposta e não chama `redigirContatoParaModulo` (nem está justificada nela).
 */

interface AutorizacaoComModulo {
  actor: { type: string };
  contatoVisivel?: boolean;
}

/** `true` quando quem chama é um módulo que NÃO pode ver contato. */
export function moduloSemContato(authz: AutorizacaoComModulo): boolean {
  return authz.actor.type === "module" && authz.contatoVisivel !== true;
}

/** Chaves cujo valor é o OBJETO do contato (ou uma lista deles): ficam só com o `id`. */
const CHAVES_DO_OBJETO_DO_CONTATO: ReadonlySet<string> = new Set(["contacts", "contact"]);

/** Campos soltos de contato que algumas respostas trazem ao lado: viram `null`. */
const CAMPOS_SOLTOS_DE_CONTATO: ReadonlySet<string> = new Set([
  "contact_name",
  "contact_display_name",
  "contact_phone",
  "contact_email",
  "contact_links",
  "contact_tags",
]);

const PROFUNDIDADE_MAXIMA = 16;

/** O que entra no lugar do identificador encontrado no texto livre. */
const SUBSTITUTO = "[contato]";

/** Chaves (do objeto do contato e dos campos soltos) de onde saem os identificadores; lidas nos 3 consumidores. */
const CHAVES_DE_NOME: ReadonlySet<string> = new Set([
  "name",
  "display_name",
  "full_name",
  "address_book_name",
  "contact_name",
  "contact_display_name",
]);
const CHAVES_DE_TELEFONE: ReadonlySet<string> = new Set(["phone_number", "phone", "phone_e164", "contact_phone"]);
const CHAVES_DE_EMAIL: ReadonlySet<string> = new Set(["email", "contact_email"]);

/** Chaves cujo texto nunca é filtrado: o id (uuid) e os marcadores que este módulo mesmo escreve. */
function chaveIntocavel(chave: string): boolean {
  return chave === "id" || chave.endsWith("_id") || chave === "redacted" || chave === "text_redacted";
}

/**
 * Dobra o texto sem mudar o comprimento: minúscula e sem acento, caractere a caractere. Posição achada no
 * texto dobrado vale no original. Caractere que não dobra para exatamente um caractere fica como está.
 */
function dobrar(texto: string): string {
  let saida = "";
  for (const c of texto.normalize("NFC")) {
    const d = c.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
    saida += d.length === c.length ? d : c;
  }
  return saida;
}

function escaparRegex(t: string): string {
  return t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const SEPARADOR = "[\\s.\\-()]*";

/** Padrão (sobre o texto dobrado) de um telefone: os últimos 8 dígitos, com qualquer separador entre eles. */
function padraoDeTelefone(bruto: string): RegExp | null {
  const digitos = bruto.replace(/\D/g, "");
  if (digitos.length < 8) return null;
  const cauda = digitos.slice(-8).split("").join(SEPARADOR);
  // Prefixo opcional: código do país, DDD (com ou sem parênteses) e o nono dígito, para não sobrar "(11) 9".
  const prefixo = `(?:\\+?55${SEPARADOR})?(?:\\(?\\d{2}\\)?${SEPARADOR})?9?${SEPARADOR}`;
  return new RegExp(`(?<!\\d)(?:${prefixo})?${cauda}(?!\\d)`, "gu");
}

/** Padrões de um nome: o nome inteiro e cada parte com 3 ou mais letras, como palavra inteira. */
function padroesDeNome(bruto: string): RegExp[] {
  const dobrado = dobrar(bruto).trim();
  const letras = (t: string) => (t.match(/\p{L}/gu) ?? []).length;
  const candidatos = new Set<string>(dobrado.split(/\s+/).filter((p) => letras(p) >= 3));
  // O nome inteiro também precisa de 3+ letras: "Li" sozinho casaria palavra demais.
  if (letras(dobrado) >= 3) candidatos.add(dobrado);
  return [...candidatos].map((c) => {
    const corpo = c.split(/\s+/).map(escaparRegex).join("\\s+");
    return new RegExp(`(?<![\\p{L}\\p{N}])${corpo}(?![\\p{L}\\p{N}])`, "gu");
  });
}

/** Padrão de e-mail (texto dobrado: já em minúscula). */
function padraoDeEmail(bruto: string): RegExp | null {
  const e = dobrar(bruto).trim();
  if (!e.includes("@")) return null;
  return new RegExp(`(?<![\\w.+-])${escaparRegex(e)}(?![\\w-])`, "gu");
}

/** Os identificadores do contato que valem para um registro e para os filhos dele. */
interface Identificadores {
  padroes: RegExp[];
}

const SEM_IDENTIFICADORES: Identificadores = { padroes: [] };

function textoNaoVazio(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/** Junta, ao que o registro já herdou, os identificadores do contato lidos ANTES de retirá-lo. */
function coletar(objeto: Record<string, unknown>, herdados: Identificadores): Identificadores {
  const padroes: RegExp[] = [];
  const lerCampo = (chave: string, v: unknown) => {
    const t = textoNaoVazio(v);
    if (t === null) return;
    if (CHAVES_DE_NOME.has(chave)) {
      padroes.push(...padroesDeNome(t));
    } else if (CHAVES_DE_TELEFONE.has(chave)) {
      const p = padraoDeTelefone(t);
      if (p) padroes.push(p);
    } else if (CHAVES_DE_EMAIL.has(chave)) {
      const p = padraoDeEmail(t);
      if (p) padroes.push(p);
    }
  };
  const lerContato = (c: unknown) => {
    if (c === null || typeof c !== "object" || Array.isArray(c)) return;
    for (const [chave, v] of Object.entries(c as Record<string, unknown>)) lerCampo(chave, v);
  };
  for (const [chave, v] of Object.entries(objeto)) {
    if (CHAVES_DO_OBJETO_DO_CONTATO.has(chave)) {
      if (Array.isArray(v)) v.forEach(lerContato);
      else lerContato(v);
    } else if (CAMPOS_SOLTOS_DE_CONTATO.has(chave)) {
      lerCampo(chave, v);
    }
  }
  return padroes.length === 0 ? herdados : { padroes: [...herdados.padroes, ...padroes] };
}

/** Troca por `[contato]` tudo que casa com algum padrão; devolve o mesmo texto quando nada casou. */
function filtrarTexto(texto: string, ident: Identificadores): string {
  if (ident.padroes.length === 0 || texto === "") return texto;
  const original = texto.normalize("NFC");
  const dobrado = dobrar(original);
  // Posição no dobrado só vale no original se o comprimento se manteve; senão, deixa como está.
  if (dobrado.length !== original.length) return texto;
  const faixas: Array<[number, number]> = [];
  for (const re of ident.padroes) {
    for (const m of dobrado.matchAll(re)) {
      if (m[0].length > 0) faixas.push([m.index, m.index + m[0].length]);
    }
  }
  if (faixas.length === 0) return texto;
  faixas.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  // Funde as faixas que se tocam (nome dentro de e-mail, telefone com prefixo) para não repetir o substituto.
  const fundidas: Array<[number, number]> = [];
  for (const [ini, fim] of faixas) {
    const ultima = fundidas[fundidas.length - 1];
    if (ultima && ini <= ultima[1]) ultima[1] = Math.max(ultima[1], fim);
    else fundidas.push([ini, fim]);
  }
  let saida = "";
  let cursor = 0;
  for (const [ini, fim] of fundidas) {
    saida += original.slice(cursor, ini) + SUBSTITUTO;
    cursor = fim;
  }
  return saida + original.slice(cursor);
}

/** Marca do registro que contém o texto: vira `text_redacted: true` quando algum valor foi trocado. */
interface MarcaDoRegistro {
  mudou: boolean;
}

/**
 * Só o `id`, mais `redacted: true`. O marcador existe para o módulo NÃO confundir "o dado foi retirado"
 * com "o dado é falso": sem ele, `is_blocked` some e quem lê o contato conclui "ninguém está bloqueado".
 */
function soOId(valor: unknown): unknown {
  if (valor === null || typeof valor !== "object") return null;
  const id = (valor as { id?: unknown }).id;
  return typeof id === "string" ? { id, redacted: true } : null;
}

function redigir(
  valor: unknown,
  profundidade: number,
  ident: Identificadores,
  dono: MarcaDoRegistro | null,
): unknown {
  if (typeof valor === "string") {
    const novo = filtrarTexto(valor, ident);
    if (novo !== valor && dono) dono.mudou = true;
    return novo;
  }
  if (profundidade > PROFUNDIDADE_MAXIMA) return valor;
  if (Array.isArray(valor)) return valor.map((x) => redigir(x, profundidade + 1, ident, dono));
  if (valor === null || typeof valor !== "object") return valor;
  const entrada = valor as Record<string, unknown>;
  // Os identificadores saem ANTES de o contato ser retirado, e valem só para este registro e os filhos dele.
  const aqui = coletar(entrada, ident);
  const marca: MarcaDoRegistro = { mudou: false };
  const saida: Record<string, unknown> = {};
  for (const [chave, x] of Object.entries(entrada)) {
    if (CHAVES_DO_OBJETO_DO_CONTATO.has(chave)) {
      saida[chave] = Array.isArray(x) ? x.map(soOId) : x === null || x === undefined ? x : soOId(x);
    } else if (CAMPOS_SOLTOS_DE_CONTATO.has(chave)) {
      saida[chave] = null;
    } else if (chaveIntocavel(chave)) {
      saida[chave] = x;
    } else {
      saida[chave] = redigir(x, profundidade + 1, aqui, marca);
    }
  }
  if (marca.mudou) saida.text_redacted = true;
  return saida;
}

/**
 * Devolve `valor` como está, ou, para módulo sem `contatos`, uma cópia sem os dados do contato
 * (só `id`) e sem os identificadores dele no texto livre do registro. Nunca altera o original: o
 * handler é compartilhado com a sessão.
 */
export function redigirContatoParaModulo<T>(authz: AutorizacaoComModulo, valor: T): T {
  if (!moduloSemContato(authz)) return valor;
  return redigir(valor, 0, SEM_IDENTIFICADORES, null) as T;
}
