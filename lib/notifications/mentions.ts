/**
 * Menção de atendente em nota interna (#2372).
 *
 * ─── O problema que este arquivo resolve ───────────────────────────────────
 * A menção era só TEXTO: `@ana` casava pelo primeiro nome, pelo trecho antes
 * do `@` do e-mail ou pelo id. Com duas Anas na organização, o `@Ana` escrito
 * na tela notificava as DUAS; com o nome trocado no cadastro, a nota antiga
 * deixava de casar. O autocompletar da #2372 existe justamente para a menção
 * não depender de o texto bater com o nome.
 *
 * ─── O formato estrutural ──────────────────────────────────────────────────
 * Quem escolhe na lista tem o id na mão, e é ali que ele é escrito:
 *
 *     Fala com @[Ana Lima](mencao:2f9c1d80-…) sobre o orçamento
 *
 * `body` continua texto puro (mesma coluna, mesmo tamanho máximo, nenhuma
 * migration): o token é um pedaço de texto que a rota lê, e o id dentro dele
 * é o do USUÁRIO, nunca uma derivação do nome. Notificar deixa de ser "o texto
 * lembra alguém" e passa a ser "este id está no corpo".
 *
 * ─── Por que o nome vai DENTRO do token ────────────────────────────────────
 * `@[Ana Lima](…)`, e não `@2f9c1d80-…`: quem lê o corpo depois não tem (nem
 * deve ter) a lista de atendentes na mão — o NoteCard, o sino e o preview do
 * push precisam escrever `@Ana Lima` sem buscar o nome em canto nenhum, e o
 * LGPD export/converter precisa de texto legível sem join de tabela. É também
 * o que a pessoa digitou: o token só existe para o computador achar o id.
 *
 * ─── Compatibilidade ───────────────────────────────────────────────────────
 * Nota antiga (`@ana`, `@ana.silva`, `@<id>`) continua casando pelo caminho
 * textual de antes — `mencaoAtingeUsuario` só ACRESCENTA o caminho estrutural.
 * Quem digita `@` à mão sem passar pela lista continua sendo avisado do jeito
 * que sempre foi, com a mesma fragilidade de sempre: isso é degradação, não
 * defeito, e a correção é digitar pelo autocompletar.
 */

/** O que o autocompletar escolheu: id de quem foi clicado + como escrever o nome. */
export interface MencaoEscolhida {
  id: string;
  nome: string;
}

/**
 * O token, inteiro, em um lugar só.
 *
 * `[^()\s]` no id: o id não pode conter espaço nem fechar o parêntese, e isso
 * é o que impede `mencao:x) Extra` de engolir texto que não é menção. Nome com
 * `]` não existe em cadastro de gente; nome com quebra de linha também não —
 * `[^]\n]` é o corte, e ele é o que mantém a regex em UMA linha.
 */
const RE_MENCAO = /@\[([^\]\n]{1,120})\]\(mencao:([^()\s]{1,64})\)/g;

/** O texto que a nota GRAVA quando alguém foi escolhido na lista. */
export function montarMencao(mencao: MencaoEscolhida): string {
  return `@[${mencao.nome.trim()}](mencao:${mencao.id})`;
}

/**
 * Ids estruturais do corpo, em minúsculas e sem repetir.
 *
 * Caso sem `@`: um corpo sem token devolve `[]`, e é esse `[]` que a rota
 * confere antes de decidir se precisa sequer olhar a tabela de membros.
 */
export function idsDeMencaoEstrutural(body: string): string[] {
  const ids = new Set<string>();
  // matchAll CLONA a regex (spec) — o lastIndex compartilhado não vira bug
  // de "às vezes casa, às vezes não" entre um corpo e outro.
  for (const trecho of body.matchAll(RE_MENCAO)) {
    const id = trecho[2];
    if (id) ids.add(id.toLowerCase());
  }
  return [...ids];
}

/**
 * O corpo como a TELA deve mostrar: `@[Ana Lima](mencao:2f9c…)` → `@Ana Lima`.
 *
 * Usado onde o texto é LIDO por gente (NoteCard, preview do push, sino) —
 * nunca onde ele é CASADO: quem casar tem de usar o corpo cru.
 */
export function textoLegivelDeMencao(body: string): string {
  return body.replace(RE_MENCAO, (_token, nome: string) => `@${nome}`);
}

/** Um pedaço do corpo, com a menção já separada — o que o NoteCard renderiza. */
export interface ParteDoCorpo {
  texto: string;
  mencao: MencaoEscolhida | null;
}

/**
 * O corpo partido em trechos de texto e menções, na ordem original: juntar os
 * `texto` e, para cada menção, `@nome` recompõe o corpo MENOS o token — que é
 * exatamente o que a tela deve mostrar. É o que permite ao NoteCard realçar
 * `@Ana Lima` sem markdown, sem HTML e sem `dangerouslySetInnerHTML` — o nome
 * vem do token, não de uma consulta.
 */
export function partesDoCorpo(body: string): ParteDoCorpo[] {
  const partes: ParteDoCorpo[] = [];
  let cursor = 0;
  for (const trecho of body.matchAll(RE_MENCAO)) {
    const inicio = trecho.index ?? 0;
    if (inicio > cursor) partes.push({ texto: body.slice(cursor, inicio), mencao: null });
    partes.push({
      texto: "",
      mencao: { id: trecho[2] ?? "", nome: trecho[1] ?? "" },
    });
    cursor = inicio + trecho[0].length;
  }
  if (cursor < body.length) partes.push({ texto: body.slice(cursor), mencao: null });
  return partes;
}

/**
 * Grava no texto o que o autocompletar escolheu, trocando `@Ana Lima` (o que
 * a pessoa VÊ no campo) pelo token com o id (o que o banco precisa GRAVAR).
 *
 * Chamada na hora de salvar, e não na hora de clicar na lista, por um motivo
 * só: no campo de texto ninguém lê `@[Ana Lima](mencao:2f9c…)`. O que fica no
 * campo é o nome; o id entra quando o corpo sai da tela.
 *
 * As três garantias desta função, cada uma com caso em `mentions.test.ts`:
 *
 *  1. Só troca a PRIMEIRA ocorrência que ainda não virou token — duas Anas
 *     escolhidas seguidas viram duas menções, não uma repetida.
 *  2. Exige limite de palavra (`(?!\p{L}\p{N})`) — `@Ana Lima` escolhida não
 *     pode cortar `@Ana Lima Silva` no meio, deixando `…](mencao:…) Silva`.
 *  3. É idempotente: o token produzido não volta a casar (`@` é seguido de
 *     `[`), então um segundo passe no mesmo texto não muda nada.
 *
 * Se a pessoa apagar o nome depois de escolher, não há o que trocar: o corpo
 * volta a ser texto puro e cai no caminho textual de sempre (degradação, não
 * perda).
 */
export function embutirMencoes(texto: string, mencoes: readonly MencaoEscolhida[]): string {
  let saida = texto;
  // Nome mais longo primeiro: com "Ana" e "Ana Lima" escolhidas, "@Ana" casaria
  // dentro de "@Ana Lima" e o token da Ana cairia em cima da Ana Lima.
  const maisLongoPrimeiro = [...mencoes].sort((a, b) => b.nome.trim().length - a.nome.trim().length);
  for (const mencao of maisLongoPrimeiro) {
    const nome = mencao.nome.trim();
    if (!nome || !mencao.id.trim()) continue;
    const re = new RegExp(`@${escaparRegex(nome)}(?![\\p{L}\\p{N}])`, "iu");
    if (!re.test(saida)) continue; // apagou ou reescreveu o nome: deixa como está
    saida = saida.replace(re, montarMencao(mencao));
  }
  return saida;
}

/** Escapa o que seria metacaracter de regex no NOME DA PESSOA (ponto, parêntese…). */
function escaparRegex(texto: string): string {
  return texto.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Os tokens `@algo` do caminho textual legado, sem `@`, em minúsculas. */
export function tokensDeMencao(body: string): string[] {
  const hits = body.match(/@[\p{L}\p{N}._-]+/gu) ?? [];
  return hits.map((t) => t.slice(1).toLowerCase());
}

/**
 * Este corpo atinge ESTE usuário?
 *
 * Estrutural primeiro, e é uma comparação de id — exata, sem heurística. Só
 * depois vem o caminho textual legado, que continua inteiro e inalterado para
 * as notas escritas antes do autocompletar (e para quem digita `@` à mão).
 */
export function mencaoAtingeUsuario(
  body: string,
  user: { id: string; email: string; full_name: string | null },
): boolean {
  const id = user.id.trim().toLowerCase();
  if (id && idsDeMencaoEstrutural(body).includes(id)) return true;

  const tokens = tokensDeMencao(body);
  if (tokens.length === 0) return false;
  if (tokens.includes(user.id.toLowerCase())) return true;
  const email = user.email.trim().toLowerCase();
  if (!email) return false;
  const local = email.split("@")[0] ?? "";
  if (tokens.includes(email) || (local && tokens.includes(local))) return true;
  const name = user.full_name?.trim().toLowerCase() ?? "";
  if (!name) return false;
  const first = name.split(/\s+/)[0] ?? "";
  const slug = name.replace(/\s+/g, "");
  return tokens.includes(first) || tokens.includes(slug);
}
