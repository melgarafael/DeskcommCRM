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
  /**
   * Onde o `@` desta escolha está no campo, no momento em que foi escrito.
   *
   * ─── Por que a posição precisa existir ──────────────────────────────────────
   *
   * A lista de escolhas é DERIVADA do texto: quem apaga `@Ana Lima` deixa de
   * ter a Ana na lista e deixa de avisá-la (#2463). Enquanto havia duas pessoas
   * com o MESMO rótulo, presença não bastava: com `@Ana Lima e @Ana Lima` no
   * campo, apagar a PRIMEIRA mantinha `[Ana 1, Ana 2]` na lista e a nota saía
   * com o id da Ana 1 — a pessoa que ficou no texto era a 2 (#2463, resíduo a).
   * O rótulo das duas é idêntico, então o texto não diz qual é qual; o que diz
   * é onde cada escolha foi escrita. Quem mantém as posições em dia durante a
   * edição é o `podarMencoesDaEdicao`.
   *
   * `undefined` é legítimo — escolha restaurada (`restoreOnError`) e escolha de
   * quem chamou a função pura não têm posição. Sem posição, a poda volta a
   * decidir por presença e a ordem é a de escolha, como antes desta correção.
   */
  inicio?: number;
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
  return aplicarMencoes(texto, mencoes).texto;
}

/** A troca de UMA ocorrência: o `@Nome` que estava em `[inicio, fim)`. */
interface Faixa {
  inicio: number;
  fim: number;
}

/**
 * A poda e a gravação disputam as mesmas ocorrências, com o nome maior primeiro.
 *
 * ─── Por que a troca é por POSIÇÃO e não "o primeiro `@Nome` do texto" ──────
 *
 * O `replace` do começo da #2372 casava sempre a PRIMEIRA ocorrência livre. Com
 * duas pessoas de rótulo idêntico, quem decide qual ocorrência é de qual
 * escolha passa a ser a posição guardada nela (#2463, resíduo a): apagar a
 * primeira de duas `@Ana Lima` deixa o texto com uma só, e é a escolha da
 * DIREITA — a que sobrou — que tem a posição certa para reivindicá-la.
 *
 * As trocas são resolvidas no texto ORIGINAL e compostas no fim: substituir
 * uma a uma no mesmo `saida` deslocaria os índices das seguintes (o token é
 * maior que o nome), e a segunda troca cairia no lugar errado.
 */
function aplicarMencoes(texto: string, mencoes: readonly MencaoEscolhida[]) {
  const encontradas = new Set<MencaoEscolhida>();
  const ocupadas: Faixa[] = [];
  const trocas: Array<{ faixa: Faixa; token: string; mencao: MencaoEscolhida }> = [];

  // Nome mais longo primeiro: com "Ana" e "Ana Lima" escolhidas, "@Ana" casaria
  // dentro de "@Ana Lima" e o token da Ana cairia em cima da Ana Lima.
  //
  // Mesmo nome (duas pessoas com o rótulo idêntico): quem ainda tem a posição
  // VÁLIDA reivindica a ocorrência dela antes de quem perdeu a posição — é o
  // que faz a escolha apagada perder a vez para a que ficou no texto.
  const maisLongoPrimeiro = [...mencoes].sort((a, b) => {
    const porTamanho = b.nome.trim().length - a.nome.trim().length;
    if (porTamanho !== 0) return porTamanho;
    const ancoraA = a.inicio === undefined ? 1 : 0;
    const ancoraB = b.inicio === undefined ? 1 : 0;
    if (ancoraA !== ancoraB) return ancoraA - ancoraB;
    return (a.inicio ?? 0) - (b.inicio ?? 0);
  });

  for (const mencao of maisLongoPrimeiro) {
    const nome = mencao.nome.trim();
    if (!nome || !mencao.id.trim()) continue;
    const faixa = faixaDaEscolha(mencao, texto, ocupadas) ?? faixaDoRotulo(nome, texto, ocupadas);
    if (!faixa) continue; // apagou ou reescreveu o nome: deixa como está
    ocupadas.push(faixa);
    trocas.push({ faixa, token: montarMencao(mencao), mencao });
    encontradas.add(mencao);
  }

  let saida = texto;
  // Da direita para a esquerda: o que ainda não foi trocado fica antes do
  // cursor de cada troca, então nenhum índice usado abaixo se desloca.
  for (const troca of [...trocas].sort((a, b) => b.faixa.inicio - a.faixa.inicio)) {
    saida = saida.slice(0, troca.faixa.inicio) + troca.token + saida.slice(troca.faixa.fim);
  }
  return { texto: saida, encontradas };
}

/** A faixa do `@Nome` desta escolha, SE a posição guardada ainda bater com o texto. */
function faixaDaEscolha(
  mencao: MencaoEscolhida,
  texto: string,
  ocupadas: readonly Faixa[],
): Faixa | null {
  const inicio = mencao.inicio;
  const nome = mencao.nome.trim();
  if (inicio === undefined || !nome) return null;
  const fim = inicio + 1 + nome.length;
  if (!eMencaoEm(texto, inicio, nome)) return null;
  if (ocupadas.some((faixa) => inicio < faixa.fim && fim > faixa.inicio)) return null;
  return { inicio, fim };
}

/**
 * A primeira ocorrência do rótulo que ainda não é de outra escolha.
 *
 * É o caminho de quem não tem posição (escolha restaurada) e o de quem perdeu
 * a posição numa edição — a nota antiga continua casando pelo nome, e o
 * `@Ana Lima123` continua não casando (`(?!\p{L}\p{N})`).
 */
function faixaDoRotulo(nome: string, texto: string, ocupadas: readonly Faixa[]): Faixa | null {
  for (const trecho of texto.matchAll(regexDaMencao(nome, true))) {
    const inicio = trecho.index ?? 0;
    const fim = inicio + trecho[0].length;
    if (ocupadas.some((faixa) => inicio < faixa.fim && fim > faixa.inicio)) continue;
    return { inicio, fim };
  }
  return null;
}

/**
 * A régua de "o `@Nome` está no texto?" — a MESMA do `embutirMencoes`.
 *
 * Existe para as duas perguntas (casar na saída e podar na edição) não
 * divergirem no primeiro ajuste: se a poda usasse um `includes()` cru, um nome
 * dentro de outro (`@Ana Lima123`) seguraria uma escolha que o `embutirMencoes`
 * nunca casaria — e a escolha morta voltaria a roubar a ocorrência da próxima,
 * que é exatamente o defeito da #2463.
 */
function regexDaMencao(nome: string, global = false): RegExp {
  return new RegExp(`@${escaparRegex(nome)}(?![\\p{L}\\p{N}])`, global ? "giu" : "iu");
}

/**
 * Esta escolha ainda tem o nome dela no texto?
 *
 * `false` para rótulo vazio (nada a casar) — quem chama decide o que fazer.
 */
export function mencaoAindaNoTexto(texto: string, mencao: MencaoEscolhida): boolean {
  const nome = mencao.nome.trim();
  if (!nome) return false;
  return regexDaMencao(nome).test(texto);
}

/**
 * As escolhas que continuam valendo depois de uma edição do texto (#2463).
 *
 * ─── O defeito que isto conserta ────────────────────────────────────────────
 *
 * A lista de escolhas só era zerada quando a nota era salva. Se a pessoa
 * apagava uma menção do texto, a escolha correspondente continuava ali — e, com
 * duas pessoas de mesmo rótulo, a escolha APAGADA roubava o `@Nome` da nova:
 * "escolher Ana (pessoa 1), apagar, escolher Ana (pessoa 2)" gravava o id da
 * pessoa 1, e a notificação ia para quem não foi mencionado.
 *
 * A precedência também é a da gravação: `@Ana Lima` escolhido consome essa
 * ocorrência antes de `Ana`. Conferir presença de cada nome isoladamente
 * conservava a Ana apagada dentro de Ana Lima; a escolha morta roubava a Ana
 * escolhida depois (#2463, resíduo b).
 *
 * Quem APAGOU uma das duas menções homônimas é decidido pela posição guardada
 * em cada escolha (`podarMencoesDaEdicao` a desloca a cada tecla): a ocorrência
 * que sobrou reivindica a escolha cuja posição ainda bate com ela (#2463,
 * resíduo a). Sem posição — escolha restaurada, nota antiga — vale a ordem.
 */
export function podarMencoes(texto: string, mencoes: readonly MencaoEscolhida[]): MencaoEscolhida[] {
  const { encontradas } = aplicarMencoes(texto, mencoes);
  const restantes = mencoes.filter((mencao) => encontradas.has(mencao));
  // Mesma referência quando nada saiu: o chamador pode usar isto num `setState`
  // a cada tecla sem re-renderizar por nada.
  return restantes.length === mencoes.length ? (mencoes as MencaoEscolhida[]) : restantes;
}

/**
 * A lista de escolhas depois de uma edição À MÃO do campo (#2463).
 *
 * ─── O que a poda por presença não enxerga ──────────────────────────────────
 *
 * Com duas pessoas de rótulo idêntico — `@Ana Lima e @Ana Lima` —, apagar a
 * PRIMEIRA deixava a lista com a escolha da ESQUERDA: o texto continua com um
 * `@Ana Lima`, e presença não distingue uma ocorrência da outra. A nota saía
 * com o id da pessoa apagada, e o aviso ia para quem não estava mais no texto.
 *
 * ─── Como a posição resolve ────────────────────────────────────────────────
 *
 * Cada escolha guarda onde o `@` dela foi escrito (`inicio`), e o que esta
 * função faz a cada tecla é MANTER essa posição apontando para o `@Nome` certo
 * — ou tirar a escolha da lista quando o trecho dela saiu do texto.
 *
 * O deslocamento vem da comparação entre o texto de antes e o de agora, por
 * PALAVRA e não por "um pedaço mudou": quem apaga a primeira de duas menções e
 * continua escrevendo na mesma tecla não pode ver o parágrafo inteiro
 * realinhado, senão a menção que ficou pareceria ter nascido no lugar da outra.
 * O alinhamento dá, para cada palavra antiga, onde ela está agora (ou "sumiu"),
 * e a escolha sobrevive enquanto a PRIMEIRA palavra do `@Nome` dela existir —
 * a conferência final (`@Nome` na posição nova) garante que o resto veio junto.
 *
 * Escolha que perdeu a posição (o trecho dela foi editado) não morre aqui: ela
 * continua na disputa pelo rótulo, e quem decide é o `podarMencoes` — a escolha
 * com posição válida reivindica a ocorrência antes, e a que perdeu a posição só
 * fica se sobrar ocorrência livre. É assim que "apagar a primeira de duas
 * `@Ana Lima`" preserva a SEGUNDA, a única cuja posição ainda bate com o texto.
 *
 * A lista final é a interseção das duas réguas: a posição diz QUAL ocorrência é
 * de quem, a presença e o "nome maior primeiro" dizem se a escolha ainda vale.
 * É a lista DERIVADA do texto — nada sobrevive ao trecho que a pessoa apagou.
 */
export function podarMencoesDaEdicao(
  anterior: string,
  atual: string,
  mencoes: readonly MencaoEscolhida[],
): MencaoEscolhida[] {
  if (anterior === atual || mencoes.length === 0) return mencoes as MencaoEscolhida[];

  const mapa = mapaDaEdicao(anterior, atual);
  let mudou = false;
  const seguidas = mencoes.map((mencao) => {
    const inicio = mencao.inicio;
    if (inicio === undefined) return mencao;
    const nome = mencao.nome.trim();
    const deslocado = mapa.mapear(inicio, inicio + 1 + nome.length);
    // A posição deixou de valer: o `@Nome` não está mais onde estava, ou o
    // texto dali em diante já não é ele.
    if (deslocado === null || !eMencaoEm(atual, deslocado, nome)) {
      mudou = true;
      return { id: mencao.id, nome: mencao.nome };
    }
    if (deslocado === inicio) return mencao;
    mudou = true;
    return { ...mencao, inicio: deslocado };
  });

  const podadas = podarMencoes(atual, seguidas);
  return !mudou && podadas.length === mencoes.length ? (mencoes as MencaoEscolhida[]) : podadas;
}

/** O `@Nome` começa em `inicio` no texto? (Sem caixa: o nome é o que a tela mostra.) */
function eMencaoEm(texto: string, inicio: number, nome: string): boolean {
  if (inicio < 0) return false;
  const fim = inicio + 1 + nome.length;
  if (fim > texto.length) return false;
  if (texto.slice(inicio, fim).toLowerCase() !== `@${nome}`.toLowerCase()) return false;
  // A mesma fronteira do `regexDaMencao`: `@Ana Lima123` não é a Ana Lima.
  return !/[\p{L}\p{N}]/u.test(texto.charAt(fim));
}

interface MapaDaEdicao {
  /** Onde começa agora o trecho que começava em `inicio` — `null` se ele saiu. */
  mapear(inicio: number, fim: number): number | null;
}

/** Uma palavra do texto, com onde ela começa e termina. */
interface Palavra {
  texto: string;
  inicio: number;
  fim: number;
}

/**
 * O deslocamento de uma edição, palavra a palavra.
 *
 * Fora do trecho que mudou, o deslocamento é a conta trivial (nada, ou o delta
 * do tamanho); dentro dele, quem responde é o alinhamento de palavras. A
 * escolha só perde a posição quando a palavra que abre o `@Nome` dela sumiu —
 * nesse caso o trecho da menção foi apagado ou reescrito.
 */
function mapaDaEdicao(anterior: string, atual: string): MapaDaEdicao {
  const faixa = faixaDaEdicao(anterior, atual);
  const delta = faixa.atualFim - faixa.anteriorFim;
  const palavrasAntes = palavrasDe(anterior.slice(faixa.inicio, faixa.anteriorFim), faixa.inicio);
  const palavrasDepois = palavrasDe(atual.slice(faixa.inicio, faixa.atualFim), faixa.inicio);
  const alinhadas = alinharPalavras(palavrasAntes, palavrasDepois);

  return {
    mapear(inicio, fim) {
      if (fim <= faixa.inicio) return inicio; // inteiro antes do que mudou
      if (inicio >= faixa.anteriorFim) return inicio + delta; // inteiro depois
      const palavra = palavrasAntes.find((p) => inicio >= p.inicio && inicio < p.fim);
      if (!palavra) return null; // o `@` caiu num espaço: a posição não aponta para nada
      const alvo = alinhadas[palavrasAntes.indexOf(palavra)];
      if (alvo === undefined || alvo < 0) return null;
      const destino = palavrasDepois[alvo]!;
      return destino.inicio + (inicio - palavra.inicio);
    },
  };
}

/** As palavras de um texto, com a posição de cada uma no texto INTEIRO. */
function palavrasDe(texto: string, base: number): Palavra[] {
  const palavras: Palavra[] = [];
  for (const achado of texto.matchAll(/\S+/g)) {
    const inicio = base + (achado.index ?? 0);
    palavras.push({ texto: achado[0], inicio, fim: inicio + achado[0].length });
  }
  return palavras;
}

/**
 * Para cada palavra do texto de antes, a palavra equivalente no de agora — a
 * MAIOR subsequência comum, a mesma ideia do `diff` (só que por palavra: mexer
 * numa palavra não realinha o resto da frase).
 *
 * Texto gigante (nota de 4 KB, colagem de parágrafo) cai no conservador: nada
 * é dado como casado, e as escolhas atingidas passam a disputar pelo rótulo.
 * A tabela é quadrática, e isso não pode virar custo por tecla.
 */
function alinharPalavras(antes: readonly Palavra[], depois: readonly Palavra[]): number[] {
  const semPar = antes.map(() => -1);
  const n = antes.length;
  const m = depois.length;
  if (n === 0 || m === 0 || n > LIMITE_DE_ALINHAMENTO || m > LIMITE_DE_ALINHAMENTO) return semPar;

  const tabela: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      tabela[i]![j] =
        antes[i]!.texto === depois[j]!.texto
          ? tabela[i + 1]![j + 1]! + 1
          : Math.max(tabela[i + 1]![j]!, tabela[i]![j + 1]!);
    }
  }

  const par = semPar;
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (antes[i]!.texto === depois[j]!.texto) {
      par[i] = j;
      i += 1;
      j += 1;
    } else if (tabela[i + 1]![j]! >= tabela[i]![j + 1]!) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return par;
}

/** Acima disso o alinhamento por palavra não roda por tecla (ver `alinharPalavras`). */
const LIMITE_DE_ALINHAMENTO = 400;

/** A faixa que a edição trocou: `anterior[inicio, anteriorFim)` → `atual[inicio, atualFim)`. */
function faixaDaEdicao(anterior: string, atual: string) {
  const menor = Math.min(anterior.length, atual.length);
  let prefixo = 0;
  while (prefixo < menor && anterior[prefixo] === atual[prefixo]) prefixo += 1;
  let sufixo = 0;
  while (
    sufixo < menor - prefixo &&
    anterior[anterior.length - 1 - sufixo] === atual[atual.length - 1 - sufixo]
  ) {
    sufixo += 1;
  }
  return { inicio: prefixo, anteriorFim: anterior.length - sufixo, atualFim: atual.length - sufixo };
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
