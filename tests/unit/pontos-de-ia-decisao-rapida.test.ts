/**
 * PONTO MARCADO COMO "DECISÃO RÁPIDA" TEM CHAMADOR DO JEV — e vice-versa.
 *
 * `decisaoRapida` no registro diz que o ponto tem uma pergunta para o Jev; a
 * tela oferece as TAREFAS (`TAREFAS_DO_JEV`, e todo ponto marcado tem uma —
 * `lib/ai/decisao/tarefas.test.ts`). Marcado sem chamador, é tarefa que não
 * controla nada: o dono liga o Jev, paga, e nada muda. Chamador sem marca é o
 * avesso: o Jev decide num ponto que a tela não mostra. Mesmo molde de `pontos-de-ia-completude.test.ts`, lendo o
 * CÓDIGO-FONTE de `lib/ai/decisao/`, onde mora todo chamador do Jev.
 *
 * Escrever `ponto: "x"` numa função que ninguém chama também é botão que não
 * controla nada. Por isso o módulo do chamador precisa ser IMPORTADO por alguém
 * fora de `lib/ai/decisao/` (o worker, a rota), e `decidirNoPonto` chamado de
 * qualquer outra raiz precisa de ponto marcado — senão a premissa "todo
 * chamador mora em lib/ai/decisao" seria só uma frase.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { PONTOS_DE_IA } from "@/lib/ai/pontos/registro";

import { arquivosDeCodigo, caminhoRelativo } from "./helpers/varrer-codigo";

const CHAMADA = /ponto:\s*["']([a-z_]+)["']/g;

/** ponto → arquivos de `lib/ai/decisao/` que o passam a `decidirNoPonto`. */
function chamadores(): Map<string, { arquivo: string; fonte: string }[]> {
  const mapa = new Map<string, { arquivo: string; fonte: string }[]>();
  for (const abs of arquivosDeCodigo(["lib/ai/decisao"])) {
    const fonte = readFileSync(abs, "utf8");
    for (const m of fonte.matchAll(CHAMADA)) {
      const lista = mapa.get(m[1]!) ?? [];
      lista.push({ arquivo: caminhoRelativo(abs), fonte });
      mapa.set(m[1]!, lista);
    }
  }
  return mapa;
}

const marcados = PONTOS_DE_IA.filter((p) => p.decisaoRapida !== undefined);
const porPonto = chamadores();

describe("decisão rápida: registro × chamador do Jev", () => {
  it("há ponto marcado e há chamador (controle positivo)", () => {
    expect(marcados.map((p) => p.id)).toContain("sentiment_classify");
    expect(porPonto.has("sentiment_classify")).toBe(true);
  });

  it("todo ponto marcado tem chamador, que pergunta na primitiva declarada", () => {
    const semChamador = marcados
      .filter((p) => {
        const quem = porPonto.get(p.id) ?? [];
        const tipo = new RegExp(`tipo:\\s*["']${p.decisaoRapida!.primitiva}["']`);
        return !quem.some((c) => tipo.test(c.fonte));
      })
      .map((p) => `${p.id} (${p.decisaoRapida!.primitiva})`);
    expect(semChamador, "ponto que a tela vai oferecer ao Jev sem ninguém chamá-lo").toEqual([]);
  });

  it("todo chamador do Jev está num ponto marcado", () => {
    const idsMarcados = new Set(marcados.map((p) => p.id));
    const orfaos = [...porPonto.entries()]
      .filter(([id]) => !idsMarcados.has(id))
      .map(([id, quem]) => `${id} (em ${quem.map((c) => c.arquivo).join(", ")})`);
    expect(orfaos, "o Jev decide num ponto que a tela não mostra").toEqual([]);
  });

  it("o módulo de cada chamador tem quem o use fora de lib/ai/decisao", () => {
    const fora = arquivosDeCodigo(["app", "lib", "workers", "components", "hooks"])
      .map(caminhoRelativo)
      .filter((c) => !c.startsWith("lib/ai/decisao/"))
      .map((c) => readFileSync(c, "utf8"));
    const semConsumidor = marcados.flatMap((p) =>
      (porPonto.get(p.id) ?? [])
        .map((c) => c.arquivo.replace(/\.tsx?$/, ""))
        // As duas aspas: o agent-engine importa com aspas simples.
        .filter((modulo) => !fora.some((fonte) => fonte.includes(`"@/${modulo}"`) || fonte.includes(`'@/${modulo}'`)))
        .map((modulo) => `${p.id} (${modulo})`),
    );
    expect(semConsumidor, "o Jev é chamado num módulo que nenhum worker ou rota importa").toEqual([]);
  });

  it("decidirNoPonto chamado de qualquer raiz cai num ponto marcado", () => {
    const idsMarcados = new Set(marcados.map((p) => p.id));
    const soltos = arquivosDeCodigo(["app", "lib", "workers", "components", "hooks"])
      .map(caminhoRelativo)
      .filter((c) => c !== "lib/ai/decisao/ponto.ts")
      .flatMap((c) => {
        const fonte = readFileSync(c, "utf8");
        if (!/\bdecidirNoPonto\(/.test(fonte)) return [];
        const ids = [...fonte.matchAll(CHAMADA)].map((m) => m[1]!);
        return ids.length > 0 && ids.every((id) => idsMarcados.has(id)) ? [] : [c];
      });
    expect(soltos, "chamada ao Jev sem ponto marcado (ou com o ponto numa variável)").toEqual([]);
  });

  it("o que a tela diz sobre o Jev está escrito para quem não é engenheiro", () => {
    const jargao = /\b(401|403|429|HTTP|timeout|token|prompt|API|score|provider)\b/i;
    const tecnicos = marcados
      .filter((p) => jargao.test(p.decisaoRapida!.oQueOJevFaz))
      .map((p) => p.id);
    expect(tecnicos).toEqual([]);
  });
});
