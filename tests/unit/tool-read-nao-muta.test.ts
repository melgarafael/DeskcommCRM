import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { amigoOperations, isAmigoMutation } from "@/lib/amigo/contracts";
import { TOOL_CATALOG } from "@/lib/mcp/tools/catalogo";

/**
 * UMA TOOL QUE GRAVA NO BANCO É ESCRITA, DIGA ELA O QUE DISSER.
 *
 * ## O buraco que este teste fecha
 *
 * `category` decide DUAS coisas por caminhos que parecem independentes e não são:
 *
 *  - o runtime monta o gate de escopo de funil com `ehEscrita: def.category === "write"`
 *    (`lib/ai/runtime/tools.ts:88`);
 *  - o gate de vacuidade cobra classificação em `ALVO_DE_FUNIL` varrendo
 *    `TOOL_CATALOG.filter((t) => t.category === "write")`
 *    (`tests/unit/escopo-de-funil.test.ts:268,281`).
 *
 * É o **mesmo predicado**. Uma escrita declarada `read` por engano é invisível para os
 * dois AO MESMO TEMPO — não há segunda opinião, por construção. E o desfecho é o caro:
 * o dono liga a capacidade na tela, o modelo gasta a chamada, o veredito não sai porque
 * o gate nem roda, e nada é gravado nem reclamado.
 *
 * Duas checagens com o mesmo predicado não são duas.
 *
 * ## A segunda opinião vem do COMPORTAMENTO, não da declaração
 *
 * Se o handler chama `.insert/.update/.delete/.upsert`, ele escreve — independente do
 * que a entrada de catálogo afirma. É um predicado genuinamente independente: vem do
 * corpo, não do campo. Precedente de varredura no repo:
 * `tests/unit/cron-audita-so-quando-ha-efeito.test.ts`.
 *
 * ## ⚠️ O LIMITE, escrito para não virar furo com aparência de cobertura
 *
 * Pega mutação **INLINE** no corpo do handler — que é o caso provável de quem escreve
 * tool nova. **NÃO pega a delegada**: o padrão deste repo é fachada fina
 * (`handler` chama `xHandler` de outro módulo), e ali a mutação não aparece no corpo.
 * Fechar isso exigiria seguir a cadeia de chamadas, que é outra ordem de custo.
 *
 * Escrito, é limite. Não escrito, seria furo com cara de cobertura.
 *
 * Nasce VERDE: medido em 53 definições, zero suspeitas. Instalar guarda no dia em que
 * ela já está satisfeita é o único momento barato — catraca que nasce vermelha precisa
 * congelar dívida antes de valer.
 */
const RAIZ = process.cwd();
const DIR = path.join(RAIZ, "lib/mcp/tools");

/** Infra do catálogo — não declaram tools. */
const NAO_SAO_DOMINIO = new Set([
  "index.ts", "catalog.ts", "catalogo-servido.ts", "pacotes.ts",
  "selecao-por-pacote.ts", "types.ts", "audit.ts", "recusa-para-o-modelo.ts", "tipos.ts",
]);

const MUTA = /\.(insert|update|delete|upsert)\s*\(/;

interface Definicao {
  name: string;
  category: string;
  corpo: string;
  arquivo: string;
}

function definicoesDeTool(): Definicao[] {
  const achadas: Definicao[] = [];
  for (const arquivo of readdirSync(DIR)) {
    if (!arquivo.endsWith(".ts") || arquivo.endsWith(".test.ts")) continue;
    if (NAO_SAO_DOMINIO.has(arquivo)) continue;
    const txt = readFileSync(path.join(DIR, arquivo), "utf8");
    // Cada `export const x: McpToolDefinition` abre um bloco que vai até o próximo.
    for (const bloco of txt.split(/(?=export const \w+: McpToolDefinition)/)) {
      const nome = /name:\s*"([^"]+)"/.exec(bloco);
      const cat = /category:\s*"(\w+)"/.exec(bloco);
      if (!nome || !cat) continue;
      achadas.push({ name: nome[1]!, category: cat[1]!, corpo: bloco, arquivo });
    }
  }
  // Ferramentas de FÁBRICA: `amigo.ts` monta uma tool por operação em
  // `operationTool`, com nome em template — o split acima não as enxerga. O
  // corpo varrido é o da fábrica inteira, e a categoria vem do mesmo predicado
  // que a fábrica usa (`isAmigoMutation`), para cada operação.
  const amigo = readFileSync(path.join(DIR, "amigo.ts"), "utf8");
  const fabrica = amigo.slice(amigo.indexOf("function operationTool("), amigo.indexOf("const linkPatient"));
  for (const operation of amigoOperations) {
    achadas.push({
      name: `crm_amigo_${operation}`,
      category: isAmigoMutation(operation) ? "write" : "read",
      corpo: fabrica,
      arquivo: "amigo.ts",
    });
  }
  return achadas;
}

describe("tool declarada read não grava no banco", () => {
  const definicoes = definicoesDeTool();

  it("CONTROLE: a varredura vê todas as tools do catálogo", () => {
    // Sem isto, um regex que parasse de casar devolveria zero definições e o teste
    // abaixo passaria varrendo o vazio — verde por instrumento morto, indistinguível
    // de verde por estar tudo certo. Este número já me pegou uma vez: uma janela de
    // regex truncou uma entrada em silêncio e a contagem saiu menor que a real.
    expect(definicoes.length).toBe(TOOL_CATALOG.length);
  });

  it("CONTROLE: o detector reconhece mutação quando ela existe", () => {
    // Exercita o predicado, não só a varredura — os dois instrumentos deste arquivo
    // precisam de controle próprio, senão um deles pode morrer sozinho.
    expect(MUTA.test('await ctx.supabase.from("x").insert({ a: 1 })')).toBe(true);
    expect(MUTA.test('await ctx.supabase.from("x").update({ a: 1 })')).toBe(true);
    expect(MUTA.test('await ctx.supabase.from("x").delete()')).toBe(true);
    expect(MUTA.test('await ctx.supabase.from("x").select("a")')).toBe(false);
  });

  it("nenhuma tool `read` tem insert/update/delete no corpo do handler", () => {
    const suspeitas = definicoes
      .filter((d) => d.category === "read" && MUTA.test(d.corpo))
      .map((d) => `${d.arquivo} → ${d.name}`);

    expect(
      suspeitas,
      "Tool declarada `read` grava no banco. `category` alimenta o MESMO predicado no " +
        "runtime (ehEscrita) e no gate de vacuidade do escopo de funil — uma escrita " +
        "declarada read é invisível para os dois ao mesmo tempo, e o sintoma é o dono " +
        "ligar a capacidade, o modelo gastar a chamada e nada acontecer. Corrija a " +
        "`category` para `write` e classifique em ALVO_DE_FUNIL.",
    ).toEqual([]);
  });
});
