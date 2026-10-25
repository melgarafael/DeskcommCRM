/**
 * O CAMPO "LISTA PESQUISÁVEL" (`searchable_select`) — issue #2521.
 *
 * ─── O defeito que este arquivo fecha ──────────────────────────────────────
 *
 * `text` aceita qualquer grafia e os filtros/relatórios não batem: o mesmo
 * destino vira `Gramado`, `gramado` e `GRAMADO`, e "quantos negócios para
 * Maceió?" exige somar seis grafias. `select`/`multiselect` renderizam a lista
 * INTEIRA de uma vez e viram inviáveis com centenas de opções (destinos, bairros,
 * especialidades). Falta um tipo que (1) mostre só o que a busca alcança, (2)
 * grave SEMPRE o valor canônico da opção escolhida e (3) aceite a lista ser
 * carregada em lote.
 *
 * ─── O que mora aqui ───────────────────────────────────────────────────────
 *
 * Tudo é função PURA sobre a definição do campo (`crm_pipelines.settings.fields`
 * → `customFieldSchema`) e os valores: normalização, busca, canonicalização,
 * a régua de aceitar/recusar e a importação de opções. Quem lê isto é a tela
 * (autocompletar da ficha, importação no editor do funil) e qualquer caminho de
 * escrita que queira padronizar antes de gravar. Nada toca I/O.
 *
 * ─── A POLÍTICA DE VALOR ESCOLHIDA (critério de sucesso "b") ────────────────
 *
 * NORMALIZA o que casa, RECUSA o que não casa — e `allow_new` abre a exceção:
 *
 *   - a entrada casa com uma opção (por `value`, `label` ou apelido, ignorando
 *     caixa, acento e espaço)? grava o `value` CANÔNICO ("maceio" → "maceio-al").
 *   - não casa e `allow_new` está DESLIGADO? RECUSA (`fora_da_lista`). É a
 *     leitura do item 6 da issue: "sem correspondência, o agente não grava e
 *     pergunta" — assim o campo nunca guarda uma sétima grafia de Maceió.
 *   - não casa e `allow_new` está LIGADO? aceita o valor aparado, como digitado.
 *     É a válvula para quem quer deixar a equipe cadastrar destino novo sem
 *     passar pelo admin.
 *
 * Vazio (ausente, `null` ou branco) nunca é recusado: limpar um campo é uma
 * escrita válida em qualquer tipo.
 *
 * RECUSAR (e não só normalizar) é o que fecha o defeito da issue: um fallback
 * silencioso para "grava o texto cru" recriaria exatamente o `text` que este
 * tipo existe para substituir.
 */
import type { CustomFieldDef } from "@/lib/schemas/settings";

/** Uma opção como o `searchable_select` a lê — o espelho do `customFieldSchema`. */
export interface OpcaoPesquisavel {
  value: string;
  label: string;
  aliases?: string[];
}

/** O `type` que este módulo governa. */
export const TIPO_DA_LISTA_PESQUISAVEL = "searchable_select" as const;

/**
 * A chave de COMPARAÇÃO: minúsculas, sem acento, espaços colapsados e aparados.
 * `Maceió `, `MACEIO` e `maceio` viram o mesmo `maceio`; `Nova York`, `nova
 *  york` e `NOVA YORK` viram `nova york`.
 *
 * NFD + remoção da faixa dos diacríticos (U+0300–U+036F) — o mesmo caminho que
 * o resto do produto usa para comparar texto sem acento, e que funciona com
 * `ç`→`c` e `ó`→`o` sem tabela à mão.
 */
export function normalizarParaBusca(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Os termos normalizados pelos quais a opção casa: `value`, `label` e apelidos. */
function termosDaOpcao(opcao: OpcaoPesquisavel): string[] {
  const termos = [opcao.value, opcao.label, ...(opcao.aliases ?? [])]
    .map(normalizarParaBusca)
    .filter((t) => t.length > 0);
  return Array.from(new Set(termos));
}

/** As opções de um campo, já no tipo do módulo; campo sem lista devolve `[]`. */
export function opcoesDoCampo(campo: Pick<CustomFieldDef, "options">): OpcaoPesquisavel[] {
  return (campo.options ?? []).map((o) => ({
    value: o.value,
    label: o.label,
    ...(o.aliases === undefined ? {} : { aliases: o.aliases }),
  }));
}

/**
 * A BUSCA do autocompletar (critério "c"): devolve as opções alcançadas por
 * `termo`, sem caixa, acento nem espaço a mais.
 *
 * Ordem: primeiro o que casa por PREFIXO (o `value`/`label`/apelido COMEÇA com o
 * termo — o que a pessoa quer ao digitar "mace"), depois o que só CONTÉM ("mace"
 * também acha "Maceió (AL)" em "Alagoas — Maceió"). Dentro de cada faixa, a
 * ordem é a de cadastro, para a lista não dançar entre duas digitações.
 *
 * Termo vazio devolve as primeiras `limite` opções — um autocompletar que abre
 * já mostrando algo, sem varrer milhares.
 */
export function buscarOpcoes(
  opcoes: OpcaoPesquisavel[],
  termo: string,
  limite = 20,
): OpcaoPesquisavel[] {
  const alvo = normalizarParaBusca(termo);
  if (alvo.length === 0) return opcoes.slice(0, Math.max(0, limite));
  const prefixo: OpcaoPesquisavel[] = [];
  const contem: OpcaoPesquisavel[] = [];
  for (const opcao of opcoes) {
    const termos = termosDaOpcao(opcao);
    if (termos.some((t) => t.startsWith(alvo))) prefixo.push(opcao);
    else if (termos.some((t) => t.includes(alvo))) contem.push(opcao);
  }
  return [...prefixo, ...contem].slice(0, Math.max(0, limite));
}

/**
 * O `value` CANÔNICO da entrada (critério "a"): a opção que casa EXATAMENTE com
 * o que foi digitado/escolhido, por `value`, `label` ou apelido, ignorando caixa,
 * acento e espaço. Sem correspondência, `null`.
 *
 * É a função que faz "maceio", "MACEIÓ" e "Maceio" virarem todas `maceio-al`.
 */
export function valorCanonico(
  opcoes: OpcaoPesquisavel[],
  entrada: string,
): string | null {
  const alvo = normalizarParaBusca(entrada);
  if (alvo.length === 0) return null;
  const achada = opcoes.find((o) => termosDaOpcao(o).includes(alvo));
  return achada ? achada.value : null;
}

/** O veredito de uma escrita num campo — o que gravar, ou por que recusar. */
export type ResultadoDoValor =
  | { ok: true; valor: unknown }
  | { ok: false; motivo: "fora_da_lista" };

/** Ausente, `null` ou branco: nada a padronizar, e limpar nunca é recusado. */
function vazio(valor: unknown): boolean {
  return valor === undefined || valor === null || (typeof valor === "string" && valor.trim() === "");
}

/**
 * O veredito de UM item de uma escrita — a mesma régua do valor único, aplicada
 * item a item no modo múltiplo. Casa? `value` canônico. Não casa e `allow_new`?
 * o texto aparado. Não casa e sem `allow_new`? recusa.
 */
function valorDeUmItem(
  campo: Pick<CustomFieldDef, "options" | "allow_new">,
  item: unknown,
): ResultadoDoValor {
  if (typeof item !== "string") {
    // A lista é de STRINGS; um número/booleano/objeto não tem como casar com
    // opção nenhuma, então cai na mesma régua de "não casou".
    return campo.allow_new === true ? { ok: true, valor: item } : { ok: false, motivo: "fora_da_lista" };
  }
  const canonico = valorCanonico(opcoesDoCampo(campo), item);
  if (canonico !== null) return { ok: true, valor: canonico };
  return campo.allow_new === true
    ? { ok: true, valor: item.trim() }
    : { ok: false, motivo: "fora_da_lista" };
}

/**
 * A RÉGUA de uma escrita num campo do funil (critério "b").
 *
 * Para QUALQUER tipo que não seja `searchable_select` é um passe direto — este
 * módulo não muda o comportamento dos tipos que já existem, byte a byte. Só o
 * tipo novo decide: normaliza o que casa, aceita cru o que `allow_new` libera,
 * recusa o resto.
 *
 * Com `multiple: true` (issue #3182) a escrita é uma LISTA e a régua é a MESMA,
 * aplicada ITEM A ITEM: cada item que casa vira o `value` canônico da sua opção,
 * o que não casa é recusado só se `allow_new` estiver desligado, e o resultado é
 * a lista de canônicos — sem repetição, porque duas grafias da mesma opção
 * ("Maceió (AL)" e "maceio") são a MESMA escolha. Um item ruim recusa a escrita
 * inteira: gravar metade da lista silenciosamente repetiria, do outro lado, o
 * defeito que este tipo existe para fechar.
 */
export function validarValorPesquisavel(
  campo: Pick<CustomFieldDef, "type" | "options" | "allow_new" | "multiple">,
  valor: unknown,
): ResultadoDoValor {
  if (campo.type !== TIPO_DA_LISTA_PESQUISAVEL) return { ok: true, valor };

  if (campo.multiple === true) {
    // Ausente/`null` e a lista vazia são "limpar": nunca recusados.
    if (valor === undefined || valor === null) return { ok: true, valor };
    if (Array.isArray(valor) && valor.length === 0) return { ok: true, valor: [] };
    // Um escalar num campo múltiplo é uma lista de UM — o mesmo valor único que
    // a ficha gravava antes de a pessoa escolher o segundo, normalizado.
    const itens = Array.isArray(valor) ? valor : [valor];
    const canonicos: unknown[] = [];
    for (const item of itens) {
      const r = valorDeUmItem(campo, item);
      if (!r.ok) return r;
      if (!canonicos.includes(r.valor)) canonicos.push(r.valor);
    }
    return { ok: true, valor: canonicos };
  }

  if (vazio(valor)) return { ok: true, valor };
  return valorDeUmItem(campo, valor);
}

/**
 * IMPORTAR OPÇÕES EM LOTE (critério "d") — o CSV que a tela do funil aceita.
 *
 * Uma opção por linha, `value,label,apelidos` — o `label` é opcional (cai no
 * `value`) e os apelidos são vários numa terceira coluna separada por `;`. Uma
 * linha de cabeçalho (`value,label,...`) é ignorada. Linhas em branco somem.
 *
 * SEM DUPLICAR: a chave de dedupe é a IDENTIDADE da opção — `value`, `label` e
 * apelidos, normalizados. Uma linha que repete qualquer uma dessas grafias de
 * uma opção que já existe (na lista OU numa linha anterior do PRÓPRIO arquivo)
 * não entra de novo e vai para `ignoradas`. Assim importar a base do IBGE duas
 * vezes não dobra a lista, e um arquivo que traz `Maceió (AL)` como `value` numa
 * linha e a opção `maceio-al` com esse `label` em outra não cria duas opções para
 * o mesmo destino. As opções JÁ existentes ficam — importar acrescenta, nunca
 * apaga.
 *
 * A lista devolvida é a NOVA lista completa (existentes + adicionadas, na ordem),
 * que é o que a tela regrava no `settings.fields` inteiro.
 */
export function importarOpcoesCsv(
  opcoesAtuais: OpcaoPesquisavel[],
  texto: string,
): { opcoes: OpcaoPesquisavel[]; adicionadas: OpcaoPesquisavel[]; ignoradas: string[] } {
  const vistos = new Set(opcoesAtuais.flatMap((o) => termosDaOpcao(o)));
  const adicionadas: OpcaoPesquisavel[] = [];
  const ignoradas: string[] = [];

  for (const linha of texto.split(/\r?\n/)) {
    const crua = linha.trim();
    if (crua.length === 0) continue;
    const colunas = crua.split(",").map((c) => c.trim());
    const value = colunas[0] ?? "";
    if (value.length === 0) continue;
    // Cabeçalho opcional (`value,label,aliases`): não é opção, é o rótulo das
    // colunas — pulado para o arquivo exportado poder ser reimportado.
    if (normalizarParaBusca(value) === "value") continue;

    const label = (colunas[1] ?? "").length > 0 ? colunas[1]! : value;
    const aliases = (colunas[2] ?? "")
      .split(";")
      .map((a) => a.trim())
      .filter((a) => a.length > 0);

    const nova: OpcaoPesquisavel = { value, label, ...(aliases.length > 0 ? { aliases } : {}) };
    // Basta UMA das grafias já conhecida para a opção ser a mesma — `value`
    // idêntico, ou o `label`/apelido batendo com o de uma opção existente.
    if (termosDaOpcao(nova).some((t) => vistos.has(t))) {
      ignoradas.push(value);
      continue;
    }
    for (const t of termosDaOpcao(nova)) vistos.add(t);
    adicionadas.push(nova);
  }

  return { opcoes: [...opcoesAtuais, ...adicionadas], adicionadas, ignoradas };
}

/**
 * EXPORTAR AS OPÇÕES EM CSV (sugestão 3 da issue #3176).
 *
 * O INVERSO EXATO da importação acima, e de propósito: `value,label,apelidos`
 * por linha, apelidos separados por `;`, encabeçado pela linha que o próprio
 * `importarOpcoesCsv` reconhece e pula. O que sai daqui volta pelo "Importar" —
 * editar a lista fora do CRM (numa planilha) e reimportar é o ciclo que a issue
 * pede, e ele só existe se o arquivo exportado for um arquivo que o importador
 * aceita.
 *
 * SEM PERDER O `value` CANÔNICO: o arquivo traz a coluna `value` (não só o
 * rótulo), então uma lista que passou por aqui e voltou continua gravando o
 * mesmo valor canônico — os negócios já registrados com ele seguem casando.
 *
 * O LIMITE É DO DIALETO DA IMPORTAÇÃO, e está declarado em vez de escondido: o
 * leitor separa as colunas por VÍRGULA e não entende aspas, então um `value`,
 * `label` ou apelido que contenha vírgula não sobrevive à ida e volta. Escapar
 * aqui seria pior — o arquivo deixaria de ser lido pelo importador que já
 * existe, e o formato da importação não muda nesta correção.
 */
export function exportarOpcoesCsv(opcoes: OpcaoPesquisavel[]): string {
  const linhas = ["value,label,apelidos"];
  for (const opcao of opcoes) {
    linhas.push(`${opcao.value},${opcao.label},${(opcao.aliases ?? []).join(";")}`);
  }
  return `${linhas.join("\n")}\n`;
}
