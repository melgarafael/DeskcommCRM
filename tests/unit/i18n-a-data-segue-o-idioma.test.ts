import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { localeDeData, tagDeIdioma } from "@/lib/i18n/datas";
import { IDIOMAS } from "@/lib/i18n/idiomas";

/**
 * A DATA SEGUE QUEM ESTÁ LENDO — e ninguém volta a fixar o idioma dela.
 *
 * ─── O estado que este guarda encerra ──────────────────────────────────────
 *
 * A tradução de TEXTO ficou completa antes desta camada existir, e o resultado
 * era pior que o português inteiro: rótulo, cabeçalho e botão em espanhol, com
 * "quinta-feira, 3 de março" no meio da tela. Parece bug, não decisão.
 *
 * A causa era mecânica e estava em dois lugares ao mesmo tempo: `locale: ptBR`
 * importado à mão do `date-fns/locale` (em 38 arquivos) e `"pt-BR"` escrito
 * dentro de `toLocaleDateString` (em mais nove). Nenhum dos dois perguntava
 * quem estava lendo — não havia a quem perguntar.
 *
 * ─── Por que um guarda, e não "agora está consertado" ──────────────────────
 *
 * Porque o defeito não some com o conserto: ele volta na próxima tela. Escrever
 * `locale: ptBR` é o caminho que todo exemplo de date-fns na internet ensina, e
 * quem escrever assim não vai errar nada visível NO PRÓPRIO TESTE — a tela
 * nasce certa em português. O erro só aparece para quem lê espanhol, que é
 * justamente quem não está na sala.
 *
 * ─── O que ele NÃO cobre, dito aqui para a ausência não virar cobertura ────
 *
 * **Número.** `toLocaleString("pt-BR")` continua em onze lugares, e ficou de
 * propósito: os dois idiomas formatam número IGUAL — medido,
 * `(1234567.89).toLocaleString("pt-BR")` e `.toLocaleString("es")` devolvem os
 * dois `1.234.567,89`. Trocar não mudaria um pixel, e mexer em onze arquivos
 * para nada é diff que o revisor precisa ler sem ter o que ganhar. Se um dia o
 * produto servir um idioma que formate número diferente (inglês, por exemplo),
 * este parágrafo vira dívida e o guarda abaixo cresce para cobri-lo.
 *
 * **Data gerada no SERVIDOR para gravar.** `app/api/v1/admin/dashboard/kpis`
 * monta o texto de um aviso no momento em que ele nasce. Isso é conteúdo
 * gravado, não interface — mesma fronteira que o PR #352 declarou para o audit
 * log e para o título de `agent_inbox_items`.
 */

const RAIZ = join(__dirname, "..", "..");
const AREAS = ["app", "components", "lib", "hooks", "workers"];
const IGNORADAS = new Set(["node_modules"]);

/**
 * Quem PODE nomear o idioma da data: a camada que existe para isso.
 *
 * Lista fechada e curta de propósito — ela é a definição de "um lugar só".
 */
const A_CAMADA_DE_DATA = new Set([
  "lib/i18n/datas.ts",
  "hooks/i18n/useLocaleDeData.ts",
]);

/**
 * Exceções, cada uma com o motivo. SÓ ENCOLHE.
 */
const FORA_DE_INTERFACE: Record<string, string> = {
  "app/api/v1/admin/dashboard/kpis/route.ts":
    "monta o texto do aviso no momento em que ele nasce — é conteúdo gravado, não interface",

  // ─── E-mail: sai do produto e não tem provider de idioma ───
  //
  // A doutrina do repo já separa esta fronteira ("Saída sem DOM usa
  // `marcaDaSaida()`"): e-mail é renderizado num worker, longe de qualquer
  // contexto de React, e o idioma do destinatário não está resolvido ali — quem
  // recebe um convite ainda NÃO TEM conta, então não tem preferência.
  //
  // Traduzir e-mail é um passe próprio: precisa decidir de onde vem o idioma
  // (da organização que convida, presumivelmente), e mexe no teste de template
  // que compara o HTML inteiro.
  "lib/email/templates/invite.ts": "e-mail: renderizado fora do React; quem recebe convite ainda não tem conta",
  "lib/lgpd/email-delivery.ts": "e-mail de LGPD: mesma fronteira do convite",
  "lib/lgpd/sla-alarm.ts": "alarme por e-mail: mesma fronteira",

  // ─── O PDF de proteção de dados é documento LEGAL, e fica em português por decisão ───
  //
  // Ele responde a um direito previsto na Lei n.º 22/11 (Angola) e nomeia o
  // CONTROLADOR (`organizations.legal_name`) — o CLAUDE.md já trata este
  // arquivo como caso especial pelo mesmo motivo. Emitir a data dele no idioma
  // da interface faria um documento de conformidade mudar de forma conforme
  // quem apertou o botão.
  "lib/lgpd/pdf-renderer.tsx": "documento legal (instalação Angola): a data acompanha a lei, não a interface",
};

function arquivos(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (IGNORADAS.has(e.name) || e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) arquivos(p, acc);
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) acc.push(p);
  }
  return acc;
}

function varrer(padrao: RegExp): string[] {
  const achados: string[] = [];
  for (const area of AREAS) {
    for (const arq of arquivos(join(RAIZ, area))) {
      const rel = relative(RAIZ, arq).split(sep).join("/");
      if (A_CAMADA_DE_DATA.has(rel) || rel in FORA_DE_INTERFACE) continue;
      const linhas = readFileSync(arq, "utf8").split("\n");
      linhas.forEach((linha, i) => {
        // O comentário explica; quem formata é o código.
        if (/^\s*(\/\/|\*|\/\*)/.test(linha)) return;
        if (padrao.test(linha)) achados.push(`${rel}:${i + 1} → ${linha.trim().slice(0, 90)}`);
      });
    }
  }
  return achados;
}

/** O receptor da chamada é uma DATA? Decide pelo que está à esquerda do ponto. */
function receptorEhData(alvo: ts.Expression, fonte: ts.SourceFile): boolean {
  if (ts.isNewExpression(alvo) && alvo.expression.getText(fonte) === "Date") return true;
  const texto = alvo.getText(fonte);
  return /\bnew Date\b/.test(texto) || /(^|\.)(data|date|dia|quando|[\w]*_at|[\w]*At)$/i.test(texto);
}

/**
 * Data formatada com o idioma FIXO, achada no AST.
 *
 * `Intl.DateTimeFormat` é sempre data. `toLocale*String` só conta quando o
 * receptor é data — senão o guarda cobraria número, que está fora de escopo
 * por medida (ver cabeçalho).
 */
function varrerDatasNoAst(): string[] {
  const achados: string[] = [];
  for (const area of AREAS) {
    for (const arq of arquivos(join(RAIZ, area))) {
      const rel = relative(RAIZ, arq).split(sep).join("/");
      if (A_CAMADA_DE_DATA.has(rel) || rel in FORA_DE_INTERFACE) continue;
      const src = readFileSync(arq, "utf8");
      if (!src.includes('"pt-BR"') && !src.includes("'pt-BR'")) continue;
      const fonte = ts.createSourceFile(arq, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const visita = (no: ts.Node): void => {
        if (ts.isStringLiteral(no) && no.text === "pt-BR") {
          const pai = no.parent;
          let ehData = false;
          if (ts.isNewExpression(pai) && /DateTimeFormat$/.test(pai.expression.getText(fonte))) {
            ehData = true;
          } else if (ts.isCallExpression(pai) && ts.isPropertyAccessExpression(pai.expression)) {
            const metodo = pai.expression.name.text;
            if (metodo === "toLocaleDateString" || metodo === "toLocaleTimeString") ehData = true;
            else if (metodo === "toLocaleString") ehData = receptorEhData(pai.expression.expression, fonte);
          }
          if (ehData) {
            const linha = fonte.getLineAndCharacterOfPosition(no.getStart()).line + 1;
            achados.push(`${rel}:${linha} → ${src.split("\n")[linha - 1]?.trim().slice(0, 90)}`);
          }
        }
        ts.forEachChild(no, visita);
      };
      visita(fonte);
    }
  }
  return achados;
}

describe("a camada de data traduz de verdade", () => {
  it("cada idioma servido tem um Locale de data PRÓPRIO", () => {
    // Um mapa que devolvesse o mesmo objeto para todos passaria em qualquer
    // teste de "existe" — e a data sairia em português para todo mundo.
    const locais = IDIOMAS.map((i) => localeDeData(i));
    expect(new Set(locais).size, "dois idiomas compartilham o mesmo Locale de data").toBe(
      IDIOMAS.length,
    );
  });

  it("a data REALMENTE muda de idioma — não é só um objeto diferente", async () => {
    const { format } = await import("date-fns");
    const dia = new Date("2026-03-05T12:00:00Z");
    const saidas = IDIOMAS.map((i) => format(dia, "EEEE, d 'de' MMMM", { locale: localeDeData(i) }));
    expect(new Set(saidas).size, `os idiomas renderizaram a mesma data: ${saidas.join(" | ")}`).toBe(
      IDIOMAS.length,
    );
    // E o português continua o que era — a camada acrescenta idioma, não muda o
    // que quem já usava enxerga.
    expect(saidas[0]).toBe("quinta-feira, 5 de março");
  });

  it("a etiqueta BCP-47 é distinta por idioma", () => {
    const tags = IDIOMAS.map((i) => tagDeIdioma(i));
    expect(new Set(tags).size).toBe(IDIOMAS.length);
  });
});

describe("ninguém fixa o idioma da data fora da camada", () => {
  it("nenhuma tela importa o locale do date-fns direto", () => {
    const vazando = varrer(/from ["']date-fns\/locale["']/);
    expect(
      vazando,
      `${vazando.length} arquivo(s) importam o locale do date-fns direto. ` +
        "Use `useLocaleDeData()` no componente, ou receba o `Locale` por parâmetro " +
        "na função auxiliar — é assim que a data segue quem está lendo.",
    ).toEqual([]);
  });

  it('nenhuma DATA é formatada com "pt-BR" fixo', () => {
    // ⚠️ PELO AST, e não por regex sobre o nome do método — o regex tinha um
    // ponto cego que a sabotagem encontrou.
    //
    // A primeira versão procurava `toLocaleDateString` e `toLocaleTimeString`,
    // deixando `toLocaleString` de fora porque ele também formata NÚMERO (que
    // fica fora de escopo, ver o cabeçalho). Só que `new Date(x)
    // .toLocaleString("pt-BR")` é DATA, e passava. Sabotei um sítio real
    // exatamente assim e o guarda ficou VERDE.
    //
    // Quem decide não é o nome do método: é o RECEPTOR. `new Date(...)` e
    // qualquer coisa chamada `data`/`date`/`*_at` é data; `n.toLocaleString()`
    // sobre número não é.
    const vazando = varrerDatasNoAst();
    expect(
      vazando,
      `${vazando.length} data(s) com o idioma fixo em "pt-BR". Use \`useTagDeIdioma()\`.`,
    ).toEqual([]);
  });
});
