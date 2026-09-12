/**
 * O INTERRUPTOR DE CHAMADA DE VOZ É UM PORTÃO, NÃO UM ENFEITE.
 *
 * ═══ O DEFEITO QUE ESTE ARQUIVO EXISTE PARA IMPEDIR ═══
 *
 * `lib/voice/guarda.ts` exporta `exigirVozLigada` — a função que lê
 * `org_voice_calls.enabled` e recusa a ação quando a organização não ligou.
 * Ela nasceu **órfã**: definida uma vez, chamada por ninguém. Varredura do
 * repositório inteiro em 11/09/2026 devolveu **uma** ocorrência, a própria
 * declaração.
 *
 * A consequência não é estética. A tela de Configurações › Segurança pede, com
 * uma caixa de seleção obrigatória, que quem administra declare *"eu li o aviso
 * e aceito o risco de o WhatsApp bloquear esta conta"*. Quem fosse direto a
 * Conexões e escaneasse o QR **pareava sem passar por ela** — e é o pareamento
 * que cria a exposição, porque a partir dele existe um segundo aparelho
 * vinculado ao número da empresa.
 *
 * Desligar sempre foi real (o `PUT` do opt-in despareia de verdade). O que não
 * existia era a exigência de LIGAR. **Um consentimento que dá para pular não é
 * consentimento**, e a tela que o pede vira controle decorativo.
 *
 * ═══ POR QUE ESTE TESTE LÊ O FONTE ═══
 *
 * O que se quer prender é "a rota CHAMA a guarda". Um teste de unidade que
 * mockasse o Supabase provaria o comportamento de UMA rota e não impediria a
 * próxima de nascer sem — e foi exatamente assim que esta nasceu. A varredura
 * por AST prende a CLASSE: toda rota que cria exposição chama a guarda, e a
 * guarda nunca volta a ficar órfã.
 *
 * O controle de comportamento (a guarda recusa quando deve, com os três
 * códigos distintos) é de `lib/voice/opt-in.ts`, que é regra pura.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { arquivosDeCodigo, caminhoRelativo, RAIZ_DO_REPO } from "./helpers/varrer-codigo";

/**
 * As rotas que CRIAM exposição — as que precisam do consentimento antes de agir.
 *
 * `pair` porque é o ato que vincula o segundo aparelho; `calls` (POST) porque
 * é o que usa o vínculo para discar.
 */
const ROTAS_QUE_EXIGEM_CONSENTIMENTO = [
  "app/api/v1/voice/sessions/pair/route.ts",
  "app/api/v1/voice/calls/route.ts",
] as const;

/**
 * As que NÃO podem ganhar a guarda, e a razão é a mesma que o cabeçalho de
 * `DELETE /api/v1/voice/sessions` já escreve: **a porta de saída nunca depende
 * do interruptor**. Exigir a feature ligada para conseguir desligá-la deixaria
 * o aparelho vinculado sem caminho de volta se a flag caísse por qualquer
 * motivo.
 */
const ROTAS_DE_SAIDA = [
  "app/api/v1/voice/sessions/route.ts",
  "app/api/v1/voice/calls/[id]/route.ts",
  "app/api/v1/voice/calls/[id]/reject/route.ts",
] as const;

function chamaAGuarda(relativo: string): boolean {
  const absoluto = path.join(RAIZ_DO_REPO, relativo);
  let texto: string;
  try {
    texto = readFileSync(absoluto, "utf8");
  } catch {
    return false;
  }
  const fonte = ts.createSourceFile(absoluto, texto, ts.ScriptTarget.Latest, true);
  let achou = false;
  const visitar = (no: ts.Node): void => {
    if (
      ts.isCallExpression(no) &&
      ts.isIdentifier(no.expression) &&
      no.expression.text === "exigirVozLigada"
    ) {
      achou = true;
    }
    ts.forEachChild(no, visitar);
  };
  visitar(fonte);
  return achou;
}

describe("o consentimento de chamada de voz é exigido onde a exposição nasce", () => {
  it("CONTROLE: os arquivos de rota existem — sem isto, tudo abaixo passaria por ausência", () => {
    for (const rota of [...ROTAS_QUE_EXIGEM_CONSENTIMENTO, ...ROTAS_DE_SAIDA]) {
      const existe = (() => {
        try {
          readFileSync(path.join(RAIZ_DO_REPO, rota), "utf8");
          return true;
        } catch {
          return false;
        }
      })();
      expect(existe, `\`${rota}\` sumiu — a lista desta sonda envelheceu`).toBe(true);
    }
  });

  it.each(ROTAS_QUE_EXIGEM_CONSENTIMENTO)("`%s` chama `exigirVozLigada`", (rota) => {
    expect(
      chamaAGuarda(rota),
      "esta rota cria exposição (vincula o segundo aparelho, ou disca por ele) e não consulta " +
        "`org_voice_calls.enabled`. A caixa 'eu li o aviso e aceito o risco' da tela de Segurança " +
        "vira enfeite: dá para pular passando por aqui.",
    ).toBe(true);
  });

  it.each(ROTAS_DE_SAIDA)("`%s` NÃO chama a guarda — a porta de saída não depende do interruptor", (rota) => {
    expect(
      chamaAGuarda(rota),
      "exigir a feature ligada para conseguir SAIR dela é o gate no lugar errado: bastaria a " +
        "flag cair para o aparelho ficar vinculado sem caminho de volta.",
    ).toBe(false);
  });

  it("a guarda não volta a ficar órfã — alguém em `app/` a chama", () => {
    const chamadores = arquivosDeCodigo(["app"]).filter((a) =>
      readFileSync(a, "utf8").includes("exigirVozLigada("),
    );
    expect(
      chamadores.map(caminhoRelativo).sort(),
      "`exigirVozLigada` ficou sem nenhum chamador. Ela nasceu assim — definida uma vez, chamada " +
        "por ninguém — e o interruptor da tela não gateava nada.",
    ).not.toEqual([]);
  });
});
