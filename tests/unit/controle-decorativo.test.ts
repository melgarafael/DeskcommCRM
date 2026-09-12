import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * VARREDURA: botão que fica cinza por falta de FIAÇÃO, não de permissão.
 *
 * ─── O padrão, e as três vezes que este repo pagou por ele ───────────────────
 * Um componente aceita `onAlgumaCoisa?` e escreve `disabled={!onAlgumaCoisa}`.
 * A tela do produto monta o componente sem passar a callback. O botão nasce
 * CINZA em toda linha, de toda organização, para sempre — e a ausência tem cara
 * de permissão, não de defeito.
 *
 *   PR #295 · cinco controles decorativos de uma vez;
 *   `useRemarcarAgendamento.ts` · "Remarcar" e "Cancelar" cinzas desde que
 *      `HistoricoDaAgenda` nasceu — só a IA conseguia remarcar;
 *   e o mesmo componente, de novo · "Realizado" e "Faltou" ficaram para trás no
 *      conserto acima, no MESMO arquivo, com a MESMA frase falsa no `title`
 *      ("Disponível quando a agenda estiver conectada" — o PATCH de status não
 *      toca o Google). Conserto por instância cobra a segunda passada.
 *
 * As quatro props nasceram juntas, no mesmo componente, com o mesmo padrão. A
 * varredura que teria consertado as quatro custava um `grep` a mais — e é este
 * arquivo.
 *
 * ─── Por que a cerca é ESTÁTICA e não um teste de tela ───────────────────────
 * `tests/e2e/agenda-kit-visual.spec.ts` já assere `toBeDisabled()` nesses
 * botões, e passa: ele roda contra a VITRINE, que legitimamente não passa
 * callback nenhuma. Um teste de tela sobre a vitrine nunca vai enxergar a
 * fiação faltando no produto — foi por isso que o defeito ficou verde por tempo
 * indeterminado.
 *
 * ─── A SEGUNDA FORMA, que esta varredura NÃO pegava ──────────────────────────
 * O padrão acima é `disabled={!callback}`. Existe outro, mais simples e mais
 * difícil de ver: **o botão que não tem `onClick` nenhum**. Ele nem fica cinza —
 * parece perfeitamente ativo, o cursor vira mãozinha, e o clique não faz nada.
 *
 * Foi assim que o "Ver na agenda" da confirmação de marcação atravessou a
 * v1.8.0: `<Button size="sm" data-testid="ver-na-agenda">Ver na agenda</Button>`,
 * sem handler. O dono do produto marcou um compromisso, clicou, e nada aconteceu.
 *
 * ⚠️ E esta varredura, que eu escrevi para pegar exatamente esta classe, era
 * CEGA para ele: ela procurava `disabled={!on...}`, e um botão mudo não tem
 * `disabled`. Guarda que cobre uma forma da classe e não a outra dá a sensação
 * de que a classe está fechada — que é pior do que não existir, porque ninguém
 * volta a olhar.
 *
 * ─── A TERCEIRA FORMA, e esta varredura NÃO A PEGA (escopo declarado) ────────
 * As duas formas acima são de FIAÇÃO DE TELA: o clique não chega a lugar nenhum.
 * Existe uma terceira em que a tela está inteira e correta — o clique chama a
 * rota, a rota grava, a tela reflete — e mesmo assim o controle é decorativo,
 * porque **ninguém LÊ o que foi gravado**.
 *
 * Foi o caso do interruptor de chamada de voz (11/09/2026): a tela pedia um
 * consentimento com caixa obrigatória, o `PUT` gravava `org_voice_calls.enabled`,
 * e a função que deveria exigi-lo — `exigirVozLigada` — tinha **zero
 * chamadores** no repositório inteiro. Dava para parear o segundo aparelho indo
 * direto a Conexões, sem passar pelo aviso.
 *
 * Esta varredura é cega para isso **por construção**: ela olha JSX, e aqui o JSX
 * está certo. Prender a terceira forma exige perguntar, por valor persistido,
 * "quem lê isto fora do caminho que escreve?" — e não há gate genérico para
 * isso hoje. A instância da voz está presa por
 * `tests/unit/voz-consentimento-e-portao-de-verdade.test.ts`.
 *
 * O escopo está escrito aqui de propósito: um comentário que defende bem uma
 * ausência incompleta impede a próxima pessoa de questioná-la.
 *
 * ─── O que conta como "ligado" ───────────────────────────────────────────────
 * Um caller em `app/app/**` — a tela do PRODUTO. A vitrine (`app/vitrine-*`) e
 * as páginas de demonstração não contam de propósito: passar a callback lá
 * silenciaria o gate sem ligar nada para o usuário.
 */
const RAIZ = process.cwd();

function arquivos(dir: string, ext: RegExp): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : arquivos(p, ext);
    return e.isFile() && ext.test(p) ? [p] : [];
  });
}

interface Controle {
  onde: string;
  prop: string;
}

/** `disabled={!onAlgo}` dentro de `components/**`. */
function controlesQueDependemDeCallback(): Controle[] {
  const out: Controle[] = [];
  for (const arquivo of arquivos(path.join(RAIZ, "components"), /\.tsx$/)) {
    const fonte = fs.readFileSync(arquivo, "utf8");
    const rel = path.relative(RAIZ, arquivo);
    for (const m of fonte.matchAll(/disabled=\{!\s*(on[A-Z][A-Za-z0-9]*)\s*\}/g)) {
      const prop = m[1] as string;
      const linha = fonte.slice(0, m.index ?? 0).split("\n").length;
      // A prop tem de ser OPCIONAL para o padrão existir; obrigatória nunca fica
      // cinza por ausência.
      if (!new RegExp(`\\b${prop}\\?\\s*:`).test(fonte)) continue;
      out.push({ onde: `${rel}:${linha}`, prop });
    }
  }
  return out;
}

/** Toda prop `onAlgo=` passada por alguma tela do PRODUTO. */
function propsLigadasNoProduto(): Set<string> {
  const ligadas = new Set<string>();
  for (const arquivo of arquivos(path.join(RAIZ, "app", "app"), /\.tsx$/)) {
    const fonte = fs.readFileSync(arquivo, "utf8");
    for (const m of fonte.matchAll(/\b(on[A-Z][A-Za-z0-9]*)=\{/g)) ligadas.add(m[1] as string);
  }
  return ligadas;
}

/**
 * Um `<Button>` é MUDO quando nada lhe dá comportamento.
 *
 * As quatro formas legítimas de um botão sem `onClick`, todas medidas contra o
 * repo real antes de virarem exclusão:
 *   - `asChild` — o comportamento é do filho (`<Link>`);
 *   - `type="submit"` — quem age é o `<form>`;
 *   - `disabled` COM `title` — o padrão da casa: diz por que não pode;
 *   - dentro de `<XTrigger asChild>` — o gatilho é o PAI, e por isso `anterior`
 *     existe como parâmetro: olhar só os atributos do botão acusaria 17 casos
 *     corretos.
 */
export function ehMudo(tagDoBotao: string, anterior: string): boolean {
  if (/\bonClick\b|\basChild\b|type="submit"/.test(tagDoBotao)) return false;
  if (/\bdisabled\b/.test(tagDoBotao) && /\btitle=/.test(tagDoBotao)) return false;
  if (/<[A-Za-z]*Trigger\b[^>]*\basChild\b[^>]*>\s*$/.test(anterior.trimEnd())) return false;
  return true;
}

function botoesMudos(): Array<{ onde: string }> {
  const out: Array<{ onde: string }> = [];
  for (const arquivo of arquivos(path.join(RAIZ, "components"), /\.tsx$/)) {
    const fonte = fs.readFileSync(arquivo, "utf8");
    const linhas = fonte.split("\n");
    const rel = path.relative(RAIZ, arquivo);
    for (const m of fonte.matchAll(/<Button\b(?:[^>]|\n)*?>/g)) {
      const n = fonte.slice(0, m.index ?? 0).split("\n").length;
      const anterior = linhas.slice(Math.max(0, n - 3), n - 1).join("\n");
      if (ehMudo(m[0], anterior)) out.push({ onde: `${rel}:${n}` });
    }
  }
  return out;
}

/** Botões mudos aceitos, por caminho:linha, com o motivo. Só ENCOLHE. */
const MUDOS_JUSTIFICADOS: Record<string, string> = {};

const CONTROLES = controlesQueDependemDeCallback();
const LIGADAS = propsLigadasNoProduto();

/**
 * Controles que ficam cinzas de propósito, com o motivo escrito. Esta lista só
 * ENCOLHE — e entrada nova precisa dizer POR QUE a tela do produto legitimamente
 * não liga aquele botão.
 */
const JUSTIFICADOS: Record<string, string> = {};

describe("nenhum botão fica cinza por falta de fiação", () => {
  it("a varredura enxerga os dois lados (senão ela mede o vazio)", () => {
    // Controle do instrumento. Sem isto, mover `components/` ou quebrar o
    // extrator deixaria o gate verde por não conhecer controle nenhum — e ele
    // afirmaria o que não mediu.
    expect(CONTROLES.length, "nenhum `disabled={!onAlgo}` encontrado").toBeGreaterThanOrEqual(4);
    expect(LIGADAS.size, "nenhuma callback encontrada em app/app").toBeGreaterThanOrEqual(20);
  });

  it("a sonda exige prop OPCIONAL — obrigatória não fica cinza por ausência", () => {
    // Prende a regra que evita o falso positivo: `onX: () => void` sem `?` é
    // sempre passada, então `disabled={!onX}` ali é outra coisa (estado, não
    // fiação).
    expect(/\bonSalvar\?\s*:/.test("  onSalvar?: () => void;")).toBe(true);
    expect(/\bonSalvar\?\s*:/.test("  onSalvar: () => void;")).toBe(false);
  });

  it("nenhum botão é MUDO — sem onClick e sem quem lhe dê comportamento", () => {
    const mudos = botoesMudos().filter((b) => !(b.onde in MUDOS_JUSTIFICADOS));
    expect(
      mudos.map((b) => b.onde),
      "Botão sem `onClick` não fica cinza: ele parece ATIVO, o cursor vira mãozinha, e o " +
        "clique não faz nada — o usuário conclui que o produto está quebrado e não tem o " +
        "que reportar além de \"não acontece nada\". Foi o \"Ver na agenda\" da v1.8.0. " +
        "Ligue o handler, ou desabilite COM o motivo à vista (`disabled` + `title`), que é " +
        "o padrão desta casa.",
    ).toEqual([]);
  });

  it("a sonda de botão mudo distingue as quatro formas legítimas", () => {
    // Controle do instrumento, e ele não é decorativo: sem estas quatro
    // exclusões a varredura acusaria 19 botões corretos e ninguém a manteria —
    // gate que grita demais é gate que se desliga.
    expect(ehMudo('<Button size="sm">Ver</Button>', "")).toBe(true);
    expect(ehMudo('<Button onClick={x}>Ver</Button>', "")).toBe(false);
    expect(ehMudo('<Button asChild><Link href="/x">Ver</Link></Button>', "")).toBe(false);
    expect(ehMudo('<Button type="submit">Salvar</Button>', "")).toBe(false);
    // `disabled` com o motivo à vista é o padrão CORRETO — o controle diz por
    // que não pode, em vez de fingir que pode.
    expect(ehMudo('<Button disabled title="ainda não implementado">X</Button>', "")).toBe(false);
    // E o gatilho que dá o comportamento mora no PAI (`<DropdownMenuTrigger
    // asChild>`), não nos atributos do próprio botão.
    expect(ehMudo('<Button size="sm">Mover…</Button>', "<DropdownMenuTrigger asChild>")).toBe(false);
  });

  it("toda callback que apaga um botão é passada por alguma tela do produto", () => {
    const mortos = CONTROLES.filter(
      (c) => !LIGADAS.has(c.prop) && !(c.prop in JUSTIFICADOS),
    ).map((c) => `${c.onde} → ${c.prop}`);

    expect(
      mortos,
      "Botão com `disabled={!callback}` e NENHUMA tela de `app/app/**` passando a " +
        "callback nasce cinza em toda linha, de toda organização, para sempre — e a " +
        "ausência tem cara de permissão, não de defeito. Este repo já pagou por isso " +
        "três vezes (PR #295 com cinco de uma vez; remarcar/cancelar; realizado/faltou). " +
        "Ligue o fio, ou declare em JUSTIFICADOS com o motivo. Passar a callback só na " +
        "vitrine NÃO conta: ela não liga nada para quem usa o produto.",
    ).toEqual([]);
  });
});
