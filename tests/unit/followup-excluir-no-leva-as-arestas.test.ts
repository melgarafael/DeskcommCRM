import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * EXCLUIR UM NÓ TEM DE LEVAR AS ARESTAS QUE TOCAVAM NELE.
 *
 * `lib/followup/excluir-do-grafo.test.ts` guarda as FUNÇÕES (`semNo`,
 * `semArestasDoNo`). Nada guardava o CALL SITE — e é lá que a perda é
 * silenciosa. Medido no HEAD da prévia do merge do PR #662: apagando a linha
 * `setEdges((eds) => semArestasDoNo(eds, id))` de `deleteNode`,
 *
 *   npx vitest run <os 5 arquivos de teste do PR>  -> 5 passed / 22 passed
 *   pnpm typecheck                                 -> exit 0
 *   pnpm lint                                      -> exit 0 (só warning de import não usado)
 *
 * ou seja: nenhum gate acusa. A spec de e2e também não alcança — ela exclui
 * `wait` e `end` ANTES de existir qualquer conexão, e a única exclusão depois
 * da conexão é a da própria aresta.
 *
 * O estrago é grafo com aresta órfã (source/target apontando para nó que não
 * existe mais). No HEAD da prévia o schema o ACEITAVA no salvamento — medido
 * com controle positivo: `flowGraphSchema.safeParse` devolvia `success=true`
 * para aresta apontando a nó inexistente E para dois nós com o mesmo id (o
 * defeito da issue #586), enquanto rejeitava campo desconhecido. A porta foi
 * fechada na #699 (superRefine de integridade em `flowGraphSchema`, casos em
 * `lib/followup/graph-schema.test.ts`). O call site continua sendo a PRIMEIRA
 * rede: não produzir o grafo órfão é melhor do que só reprovar o rascunho
 * depois de corrompido.
 *
 * Guarda de FONTE, não de comportamento: o canvas não renderiza em jsdom
 * (XYFlow precisa de medição de DOM). O recorte é o corpo do `deleteNode`,
 * achado por contagem de chaves — não o arquivo inteiro, senão o import no
 * topo já satisfaria a asserção.
 */

const FONTE = "app/app/ai/followups/[id]/_components/FlowCanvas.tsx";
const SRC = readFileSync(FONTE, "utf8");

/** Corpo do `const <nome> = useCallback(` até fechar as chaves que abriu. */
function corpoDoCallback(nome: string): string {
  const i = SRC.indexOf(`const ${nome} = useCallback(`);
  if (i < 0) throw new Error(`não achei \`const ${nome} = useCallback(\` em ${FONTE}`);
  const abre = SRC.indexOf("{", i);
  if (abre < 0) throw new Error(`\`${nome}\` sem corpo em ${FONTE}`);
  let nivel = 0;
  for (let k = abre; k < SRC.length; k++) {
    if (SRC[k] === "{") nivel++;
    else if (SRC[k] === "}" && --nivel === 0) return SRC.slice(abre, k + 1);
  }
  throw new Error(`\`${nome}\` sem fechamento em ${FONTE}`);
}

describe("excluir nó no canvas de follow-up", () => {
  it("tira o nó E as arestas que tocavam nele — não deixa aresta órfã", () => {
    const corpo = corpoDoCallback("deleteNode");
    expect(corpo).toMatch(/setNodes\(.*semNo\(/s);
    expect(corpo).toMatch(/setEdges\(.*semArestasDoNo\(/s);
  });

  it("excluir ARESTA mexe só nas arestas — não remove nó junto", () => {
    const corpo = corpoDoCallback("deleteEdge");
    expect(corpo).toMatch(/setEdges\(.*semAresta\(/s);
    expect(corpo).not.toMatch(/setNodes\(/);
  });

  it("CONTROLE POSITIVO: o recorte é o corpo do callback, não o arquivo", () => {
    // o import mora no topo do arquivo e está FORA do corpo — se estivesse
    // dentro, o caso de cima passaria mesmo com a cascata apagada.
    expect(SRC).toMatch(/import \{[^}]*semArestasDoNo[^}]*\} from "\@\/lib\/followup\/excluir-do-grafo"/);
    expect(corpoDoCallback("deleteNode")).not.toContain("from \"@/lib/followup/excluir-do-grafo\"");
    expect(() => corpoDoCallback("naoExisteEsteCallback")).toThrow(/não achei/);
  });
});
