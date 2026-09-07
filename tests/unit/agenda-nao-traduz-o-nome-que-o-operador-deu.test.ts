import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, sep } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * O NOME QUE O OPERADOR DEU A UM TIPO DE ATENDIMENTO NÃO É TRADUZIDO.
 *
 * ─── O defeito, achado por @JowaniOrantes no PR #600 ────────────────────────
 *
 * `calendar_appointments.title` é gravado como `input.title ?? tipo.name`
 * (`app/api/v1/agenda/agendamentos/_handler.ts`), e `tipo.name` é o nome que o
 * operador cadastrou em Tipos de agendamento. É dado dele, não rótulo nosso.
 *
 * A tradução da Agenda (commit `08257eed`, já na main antes do #600) passou
 * esse campo por `t()`. Numa clínica com um tipo chamado "Retorno" a agenda em
 * espanhol mostrava "Seguimiento" — palavra que não está em lugar nenhum do
 * cadastro dela, e que ela não consegue procurar. Dado do operador sai como ele
 * escreveu, em qualquer idioma; é a mesma regra que já vale para nome de funil,
 * rótulo de etapa e conteúdo de mensagem.
 *
 * ─── O que este guarda cobre, e o que NÃO cobre ─────────────────────────────
 *
 * Cobre a superfície da Agenda e os DOIS campos que a `Agendamento`
 * (`components/agenda/tipos.ts`) declara como texto livre vindo do banco:
 * `titulo` e `tipo`. É decidível estaticamente porque os nomes são fixos.
 *
 * NÃO cobre a classe inteira — "`t()` aplicado a valor que veio do banco" é
 * indecidível no geral, e a árvore tem outras chamadas `t(<valor de runtime>)`
 * que são legítimas (vocabulário NOSSO resolvido em runtime, como
 * `t(activityLabel(item.type))`). Separar as duas exige saber a origem do dado,
 * que o AST não tem. Este guarda prende os dois campos onde o defeito foi
 * medido; a classe geral é problema de outro passe.
 */

const RAIZ = join(__dirname, "..", "..");

/** A superfície onde a `Agendamento` pode ser renderizada. */
const AREAS = ["components/agenda", "app/app/agenda", "app/app/settings/tenant/agenda"];

/**
 * Dentro dessas áreas, só os arquivos que MEXEM com `Agendamento`.
 *
 * Sem este corte o guarda acusava `t(desfecho.titulo)` em
 * `AvisoDaConexaoGoogle.tsx` — um `Record` de rótulos NOSSOS que por acaso tem
 * um campo com o mesmo nome. Medido: 3 falsos positivos, todos ali. O nome do
 * campo sozinho não diz de quem é o dado; quem diz é o tipo que o arquivo
 * manuseia, e é isso que o `\bAgendamento\b` aproxima sem precisar do
 * type-checker (que exigiria compilar o projeto inteiro dentro de um teste).
 */
const USA_O_TIPO = /\bAgendamento\b/;

/**
 * Os campos de `Agendamento` que carregam texto do operador.
 *
 * `quemSeraAtendido` (nome do contato) e `local` também são dado, mas nunca
 * passaram por `t()` — entram aqui porque a próxima pessoa a mexer na tela não
 * tem por que saber disso de cor.
 */
const CAMPOS_DO_OPERADOR = ["titulo", "tipo", "quemSeraAtendido", "local"];

function nomeDaChamada(no: ts.CallExpression): string {
  const alvo = no.expression;
  if (ts.isIdentifier(alvo)) return alvo.text;
  if (ts.isPropertyAccessExpression(alvo)) return alvo.name.text;
  return "";
}

interface Sitio {
  local: string;
  trecho: string;
}

/**
 * Devolve os sítios acusados e quantas chamadas a `t()` foram visitadas — o
 * segundo número separa "não achei defeito" de "não olhei nada".
 */
function varrer(fontes: { rel: string; texto: string }[]): { sitios: Sitio[]; chamadas: number } {
  const sitios: Sitio[] = [];
  let chamadas = 0;

  for (const { rel, texto } of fontes) {
    const fonte = ts.createSourceFile(rel, texto, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visita = (no: ts.Node): void => {
      if (ts.isCallExpression(no) && ["t", "traduzir"].includes(nomeDaChamada(no))) {
        chamadas += 1;
        const arg = no.arguments[0];
        if (arg && !ts.isStringLiteral(arg) && !ts.isNoSubstitutionTemplateLiteral(arg)) {
          // Só o acesso a PROPRIEDADE conta: `t(tipoDoNo(x))` resolve
          // vocabulário nosso e não pode ser acusado.
          const lidos: string[] = [];
          const olha = (n: ts.Node): void => {
            if (ts.isPropertyAccessExpression(n) && CAMPOS_DO_OPERADOR.includes(n.name.text)) {
              lidos.push(n.name.text);
            }
            ts.forEachChild(n, olha);
          };
          olha(arg);
          if (lidos.length > 0) {
            const linha = fonte.getLineAndCharacterOfPosition(no.getStart()).line + 1;
            sitios.push({
              local: `${rel}:${linha}`,
              trecho: no.getText(fonte).replace(/\s+/g, " ").slice(0, 100),
            });
          }
        }
      }
      ts.forEachChild(no, visita);
    };
    visita(fonte);
  }
  return { sitios, chamadas };
}

function fontesDaAgenda(): { rel: string; texto: string }[] {
  const saida = execFileSync("git", ["ls-files", ...AREAS], {
    cwd: RAIZ,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return saida
    .split("\n")
    .filter((p) => /\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p))
    .map((rel) => ({ rel, texto: readFileSync(join(RAIZ, rel.split("/").join(sep)), "utf8") }))
    .filter(({ texto }) => USA_O_TIPO.test(texto));
}

describe("a Agenda mostra o nome que o operador cadastrou", () => {
  const fontes = fontesDaAgenda();
  const { sitios, chamadas } = varrer(fontes);

  it("nenhum campo de texto do operador passa por t()", () => {
    expect(
      sitios.map((s) => `${s.local} → ${s.trecho}`),
      `${sitios.length} sítio(s) traduzem dado do operador: "Retorno" vira ` +
        '"Seguimiento" e a pessoa não acha na agenda dela o nome que cadastrou',
    ).toEqual([]);
  });

  it("a varredura enxergou a superfície da Agenda (não é sonda cega)", () => {
    expect(fontes.length, "nenhum arquivo da Agenda foi lido").toBeGreaterThan(4);
    expect(chamadas, "nenhuma chamada a t() foi visitada").toBeGreaterThan(50);
  });

  it("a varredura acusa o defeito quando ele existe (controle positivo)", () => {
    const comDefeito = `
      const a = <span>{t(agendamento.titulo)}</span>;
      const b = <span>{a.tipo ? t(a.tipo) : t("Agendamento")}</span>;
      const c = <span>{t("Agendamento")}</span>;
      const d = <span>{t(tipoDoNo(no.kind))}</span>;
    `;
    const achado = varrer([{ rel: "sintetico.tsx", texto: comDefeito }]);
    // Linhas 2 e 3 são o defeito; `t("Agendamento")` (rótulo nosso) e
    // `t(tipoDoNo(...))` (vocabulário nosso em runtime) NÃO podem ser acusados
    // — senão o guarda proibiria traduzir a própria tela.
    expect(achado.sitios.map((s) => s.local)).toEqual(["sintetico.tsx:2", "sintetico.tsx:3"]);
  });

  it("a Agenda continua traduzida — o par do «não faça X»", () => {
    // Sem este caso, arrancar `t()` da Agenda inteira satisfaria o guarda de
    // cima e devolveria a tela em português para quem escolheu espanhol.
    //
    // O PISO É BAIXO DE PROPÓSITO. Medido nesta branch: **57** chamadas
    // `t("literal")` dentro de `fontes` — que é um RECORTE (só os arquivos que
    // mexem com `Agendamento`), não a Agenda inteira, onde são 140. Este caso
    // existe para provar que a sonda enxerga `t()`, não para medir cobertura:
    // um piso colado no número de hoje reprova o próximo PR que mover um
    // componente de lugar, e aí alguém o afrouxa sem ler o porquê.
    const literais = fontes.reduce(
      (soma, { texto }) => soma + (texto.match(/(?<![\w$.])t\(\s*["'`]/g) ?? []).length,
      0,
    );
    expect(literais, "a Agenda perdeu as chamadas t() dos rótulos dela").toBeGreaterThan(30);
  });
});
