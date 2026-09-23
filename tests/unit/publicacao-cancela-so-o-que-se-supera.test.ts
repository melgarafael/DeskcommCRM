/**
 * O publish-image.yml cancela a rodada superada em pull_request E no push da
 * `main` (o `latest` superado é sobrescrito minutos depois), mas NUNCA a de uma
 * tag — é ela que publica a versão e promove `stable`. Aqui a expressão do
 * workflow é AVALIADA nos quatro eventos, não só lida.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const YML = readFileSync(".github/workflows/publish-image.yml", "utf-8");

// O `concurrency:` mora no job (ver o cabeçalho do ci.yml). Os três jobs de
// build usam a mesma condição — concorrencia-so-nos-jobs-pesados.test.ts cobra
// isso —, então basta avaliar a do build-and-push.
function campo(chave: "group" | "cancel-in-progress"): string {
  const inicio = YML.indexOf("\n  build-and-push:\n");
  const bloco = YML.slice(inicio, YML.indexOf("\n    steps:", inicio));
  const m = bloco.match(new RegExp(`^ {6}${chave}: (.+)$`, "m"));
  if (!m?.[1]) throw new Error(`build-and-push.concurrency.${chave} não encontrado`);
  return m[1];
}

type Contexto = {
  event_name: string;
  ref: string;
  workflow: string;
  pr?: number;
  matriz: string;
  tentativa?: string;
  head?: string;
};

// Tradutor mínimo das expressões do Actions usadas aqui (==, !=, ||, &&,
// strings entre aspas simples, `format`). Qualquer outro token faz `new
// Function` falhar e o teste reprovar — melhor que avaliar errado em silêncio.
// `run_attempt` é string no Actions ('1', '2'…), e é assim que entra aqui.
function avaliar(expr: string, c: Contexto): unknown {
  const js = expr
    .replace(/github\.event\.pull_request\.number/g, "c.pr")
    .replace(/github\.event\.pull_request\.head\.sha/g, "c.head")
    .replace(/github\.run_attempt/g, "(c.tentativa ?? '1')")
    .replace(/github\.event_name/g, "c.event_name")
    .replace(/github\.workflow/g, "c.workflow")
    .replace(/github\.ref\b/g, "c.ref")
    .replace(/matrix\.name/g, "c.matriz")
    .replace(/==/g, "===")
    .replace(/!=/g, "!==");
  const format = (modelo: string, ...args: unknown[]) =>
    modelo.replace(/\{(\d+)\}/g, (_, i: string) => String(args[Number(i)]));
  return new Function("c", "format", `return (${js});`)(c, format);
}

// `texto-${{ a }}-${{ b }}` → cada `${{ }}` avaliado e concatenado.
function interpolar(modelo: string, c: Contexto): string {
  return modelo.replace(/\$\{\{ (.+?) \}\}/g, (_, e: string) => String(avaliar(e, c)));
}

const WORKFLOW = "Publicar imagem Docker (GHCR)";
const EVENTOS = {
  pr: { event_name: "pull_request", ref: "refs/pull/42/merge", workflow: WORKFLOW, pr: 42, matriz: "deskcommcrm" },
  main: { event_name: "push", ref: "refs/heads/main", workflow: WORKFLOW, matriz: "deskcommcrm" },
  tag: { event_name: "push", ref: "refs/tags/v1.35.0", workflow: WORKFLOW, matriz: "deskcommcrm" },
  dispatch: { event_name: "workflow_dispatch", ref: "refs/heads/main", workflow: WORKFLOW, matriz: "deskcommcrm" },
} satisfies Record<string, Contexto>;

describe("publish-image: cancela só o que se supera", () => {
  const cancela = campo("cancel-in-progress");
  const grupo = campo("group");

  it("cancela PR e push da main; nunca tag nem dispatch", () => {
    expect(interpolar(cancela, EVENTOS.pr)).toBe("true");
    expect(interpolar(cancela, EVENTOS.main)).toBe("true");
    expect(interpolar(cancela, EVENTOS.tag)).toBe("false");
    expect(interpolar(cancela, EVENTOS.dispatch)).toBe("false");
  });

  // Segunda trava, independente da primeira: mesmo que a condição mudasse, a
  // tag cai num grupo só dela e não há rodada da main para cancelá-la.
  it("tag fica fora do grupo da main — o grupo de uma tag é só dela", () => {
    const g = (c: Contexto) => interpolar(grupo, c);
    expect(g(EVENTOS.tag)).not.toBe(g(EVENTOS.main));
    expect(g(EVENTOS.tag)).toContain("refs/tags/v1.35.0");
    expect(g({ ...EVENTOS.tag, ref: "refs/tags/v1.36.0" })).not.toBe(g(EVENTOS.tag));
    // E a matriz entra no grupo: sem ela, o build do worker cancelaria o do app.
    expect(g({ ...EVENTOS.pr, matriz: "deskcomm-worker" })).not.toBe(g(EVENTOS.pr));
  });

  // Reentrada — aprovação de `action_required` ou rerun, ambas tentativa ≥ 2 —
  // vai para o grupo do SEU head e não cancela o head atual de outro commit.
  // Medido em 22/09/2026: a aprovação do run velho do #1446 cancelou o
  // `verify-parte` do head novo. A razão inteira está no cabeçalho do ci.yml.
  it("reentrada num PR fica no grupo do seu head; a primeira tentativa, no do PR", () => {
    const g = (c: Contexto) => interpolar(grupo, c);
    const novo = { ...EVENTOS.pr, head: "096b49930aaa" };
    const velho = { ...EVENTOS.pr, head: "42abeb075bbb" };
    // Primeira tentativa: o grupo do PR, como sempre — o push novo cancela o velho.
    expect(g(novo)).toBe(g(velho));
    expect(g(novo)).not.toContain("reentrada");
    // O run velho aprovado depois NÃO cai no grupo do head novo.
    expect(g({ ...velho, tentativa: "2" })).not.toBe(g(novo));
    expect(g({ ...velho, tentativa: "2" })).not.toBe(g({ ...novo, tentativa: "2" }));
    expect(g({ ...velho, tentativa: "2" })).toContain("42abeb075bbb");
    // Reruns do MESMO head continuam dividindo um grupo.
    expect(g({ ...novo, tentativa: "2" })).toBe(g({ ...novo, tentativa: "3" }));
    // Fora de PR nada muda: o rerun da main segue no grupo da main.
    expect(g({ ...EVENTOS.main, tentativa: "2" })).toBe(g(EVENTOS.main));
  });
});
