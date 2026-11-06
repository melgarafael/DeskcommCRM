/**
 * O EXPORT de contatos — CSV e vCard, os dois formatos que a tela de Contatos
 * passa a oferecer ao lado de "Importar CSV" (issue #2759).
 *
 * ─── Por que estes dois, e não um terceiro ──────────────────────────────────
 *
 * O CSV é o MESMO formato que a tela já importa (`lib/contacts/csv.ts`): as
 * colunas de cá são exatamente as que o importer de lá reconhece, então o
 * round-trip é de verdade — exportar e reimportar devolve as mesmas pessoas
 * com as mesmas etiquetas. O vCard (`.vcf`) é o formato que o celular importa,
 * Android e iOS nativamente, e o produto já sabe LER cartão desde a #2712
 * (`lib/messaging/contact-card.ts`); faltava escrever. Quem passou a operação
 * para o CRM não conseguia tirar a agenda de volta para o aparelho, e o caminho
 * de ida já existe: a #2736 propõe importar a agenda do celular para cá.
 *
 * ─── O que o writer promete ao reader ───────────────────────────────────────
 *
 * `parseVcard` lê `FN:` e `TEL…:` linha a linha, SEM unescape nenhum. Por isso
 * o `FN` sai aqui sem escape de vírgula (`SILVA, MARIA` chega inteiro ao
 * reader de cá e ao celular); o que sai é só o que quebraria a LINHA — quebra
 * de linha e caractere de controle. A troca é declarada: escapar produziria
 * `SILVA\, MARIA` na tela de quem usa o reader próprio, e o produto não tem
 * quem desfaça o escape.
 *
 * O CSV nasce com BOM: o Excel em português precisa dele para ler acento, e o
 * import já o remove (`parseCsv`/`decodificarCsv`) — é o mesmo contrato de
 * sempre, só que do lado de cá.
 */
import type { ModoDeEtiqueta } from "@/lib/inbox/marcador-da-conversa";
import { marcadoresEscolhidos } from "@/lib/inbox/marcador-da-conversa";

/**
 * As colunas que o importer reconhece (`HEADER_ALIASES` em
 * `lib/contacts/csv.ts`) — nesta ordem, sem nenhuma a mais: uma coluna que o
 * import não lê seria promessa de round-trip que não fecha.
 */
export const COLUNAS_DO_CSV = [
  "name",
  "display_name",
  "email",
  "phone_number",
  "cpf",
  "birthdate",
  "tags",
] as const;

export type FormatoDeExport = "csv" | "vcf";

/**
 * O recorte de um contato que os dois formatos usam.
 *
 * `cpf` vem EM CLARO — a rota decifra com a RPC `decrypt_cpf` (papel manager,
 * audit dentro da própria função); sem cifra disponível a coluna sai vazia em
 * vez de derrubar o arquivo.
 */
export interface ContatoParaExportar {
  name?: string | null;
  display_name?: string | null;
  email?: string | null;
  phone_number?: string | null;
  cpf?: string | null;
  /** Data de calendário `YYYY-MM-DD`, no mesmo formato que o importador lê. */
  birthdate?: string | null;
  tags?: readonly string[] | null;
}

function neutralizarFormula(trecho: string): string {
  return /^[=+\-@\t\r]/.test(trecho) && !/^\+\d+$/.test(trecho) ? `'${trecho}` : trecho;
}

/**
 * RFC 4180, mais a neutralização de célula que começa com caractere de fórmula
 * — a mesma regra do export de tenants (`app/api/v1/admin/tenants/export/_csv.ts`).
 * Telefone E.164 (`+` e só dígitos) passa intacto: o `'` na frente dele
 * quebraria o round-trip.
 */
function csvEscape(valor: unknown): string {
  if (valor === null || valor === undefined) return "";
  const bruto = typeof valor === "string" ? valor : String(valor);
  // Quem lê o CSV nem sempre divide como nós: o Excel em pt-BR divide por `;`
  // e ali as aspas de um campo que não começa com aspa não protegem nada, então
  // uma quebra de linha abre linha nova; leitor sem aspas divide em `,`. Todo
  // trecho que começa depois de `;`, `,`, LF ou CR pode virar célula: cada um
  // sai como texto, e não só o começo.
  const texto = bruto.split(/(?<=[;,\n\r])/).map(neutralizarFormula).join("");
  if (/[",\n\r]/.test(texto)) return `"${texto.replace(/"/g, '""')}"`;
  return texto;
}

export const CABECALHO_DO_CSV = COLUNAS_DO_CSV.join(",");

/**
 * Uma linha de dados.
 *
 * `tags` sai com `;` de separador porque é o que `mapLinha` usa para voltar a
 * lista (`split(/[;|]/)`) — a vírgula estaria dentro de um campo que o
 * importador não divide, e a barra é o outro separador dele.
 */
export function linhaDoCsv(contato: ContatoParaExportar): string {
  const tags = (contato.tags ?? []).filter((tag) => tag !== "").join(";");
  return [
    contato.name,
    contato.display_name,
    contato.email,
    contato.phone_number,
    contato.cpf,
    contato.birthdate,
    tags,
  ]
    .map(csvEscape)
    .join(",");
}

/** BOM + cabeçalho + linhas. `parseCsv` tira o BOM e detecta a vírgula. */
export function csvDosContatos(contatos: readonly ContatoParaExportar[]): string {
  const linhas = [CABECALHO_DO_CSV, ...contatos.map(linhaDoCsv)];
  return `\uFEFF${linhas.join("\n")}\n`;
}

/**
 * Uma linha vCard vira valor de campo sem quebrar a linha.
 * O `FN` é o único campo obrigatório de um cartão de contato.
 */
function valorDeCartao(valor: string | null | undefined): string {
  return (valor ?? "").replace(/[\r\n]+/g, " ").trim();
}

/**
 * UM cartão (vCard 3.0) com `FN`, `TEL` e `EMAIL`.
 *
 * `TEL;TYPE=CELL,VOICE:` casa com o regex do reader próprio
 * (`/^(?:[\w-]+\.)?TEL[^:]*:(.+)$/mi`) e é a forma que Android e iOS escrevem.
 * Sem telefone o cartão sai com `FN` + `EMAIL` — cartão só de e-mail ainda é
 * um contato que o celular aceita; cartão sem nada de apresentável não sai.
 */
export function vcardDoContato(contato: ContatoParaExportar): string | null {
  const nome = valorDeCartao(contato.name) || valorDeCartao(contato.display_name);
  const telefone = valorDeCartao(contato.phone_number);
  const email = valorDeCartao(contato.email);
  const identidade = nome || telefone || email;
  if (!identidade) return null;

  const linhas = ["BEGIN:VCARD", "VERSION:3.0", `FN:${identidade}`];
  if (telefone) linhas.push(`TEL;TYPE=CELL,VOICE:${telefone}`);
  if (email) linhas.push(`EMAIL;TYPE=INTERNET:${email}`);
  linhas.push("END:VCARD");
  return `${linhas.join("\n")}\n`;
}

/**
 * UM arquivo com N cartões — o que Android e iOS esperam receber (um `.vcf`
 * por contato obrigaria a baixar N vezes para uma base de trabalho).
 */
export function vcardsDosContatos(contatos: readonly ContatoParaExportar[]): string {
  return contatos
    .map(vcardDoContato)
    .filter((cartao): cartao is string => cartao !== null)
    .join("");
}

/**
 * `contatos-YYYY-MM-DD.csv|vcf` — o MESMO formato do export de auditoria
 * (`audit-YYYY-MM-DD.csv`), só muda o prefixo: o nome do arquivo diz QUANDO a
 * base foi tirada, que é a metade da prova que a LGPD pede.
 */
export function nomeDoArquivo(formato: FormatoDeExport, hoje: Date = new Date()): string {
  return `contatos-${hoje.toISOString().slice(0, 10)}.${formato}`;
}

/** Filtros da tela de Contatos, na forma em que eles saem dela. */
export interface FiltrosDaTela {
  search?: string;
  tags?: readonly string[];
  tagMode?: ModoDeEtiqueta;
  source?: string;
  pessoais?: boolean;
  order_by?: string;
  order_dir?: "asc" | "desc";
}

/**
 * A query do export a partir do MESMO estado de filtro da lista.
 *
 * Repete as regras de `useContactList` (`hooks/contacts/useContactList.ts`) de
 * propósito: exportar é exportar o que a tela está mostrando, então o `?tag=`
 * viaja repetido, o `modo=ou` só quando é ou, e `pessoais` só quando ligado —
 * o parâmetro desligado mudaria a URL sem mudar o resultado.
 */
export function queryDaExportacao(
  formato: FormatoDeExport,
  filtros: FiltrosDaTela,
): string {
  const qs = new URLSearchParams();
  qs.set("formato", formato);
  if (filtros.search) qs.set("search", filtros.search);
  for (const marcador of marcadoresEscolhidos(filtros.tags ?? [])) qs.append("tag", marcador);
  if (filtros.tagMode === "ou") qs.set("modo", "ou");
  if (filtros.source) qs.set("source", filtros.source);
  if (filtros.pessoais) qs.set("pessoais", "true");
  if (filtros.order_by) qs.set("order_by", filtros.order_by);
  if (filtros.order_dir) qs.set("order_dir", filtros.order_dir);
  return qs.toString();
}
