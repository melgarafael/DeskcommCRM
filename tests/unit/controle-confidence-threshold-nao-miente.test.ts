/**
 * O CONTROLE "CONFIDENCE THRESHOLD" PROMETIA ESCALAR PARA HUMANO E NÃO
 * ESCALAVA NINGUÉM (issue #1660).
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 *
 * A aba RAG do editor de agente oferecia um campo "Confidence threshold (0–1)"
 * com a frase "limiar abaixo do qual o agent escala para humano". Quem mexia
 * nele gravava um valor, recebia o toast de salvo, e nada mudava: o único
 * leitor de `config.confidence_threshold` era o bloco G3 de
 * `workers/ai-response-worker.ts`, que roda DEPOIS de
 * `if (!elegivelParaWorkerLegado(ctx.agent)) return ...` — e essa régua
 * devolve `false` desde `d69d708d8` (07/09), quando o worker legado foi
 * desligado por criar um evento de envio órfão. O conserto `9ad41ffd1` até
 * mexeu no bloco G3; mexeu em código morto.
 *
 * É a mesma lesão que `tests/unit/pontos-de-ia-completude.test.ts` combate no
 * painel de provedores, e as palavras do próprio repo são "botão que não
 * controla nada é pior que botão ausente": um controle que não controla gasta
 * a confiança do operador numa tela que mente.
 *
 * ─── Por que escanear o código-fonte ────────────────────────────────────────
 *
 * O defeito é uma AUSÊNCIA de consumidor, e ausência não se testa renderizando
 * a tela: o campo existia, renderizava, validava e salvava. O que faltava estava
 * espalhado por quatro arquivos (componente, schema, worker, seed), então a
 * régua é olhar o código que o produto executa e afirmar que a chave não está
 * em mais nenhum deles. A varredura mora em `helpers/varrer-codigo` e este
 * teste tem controle positivo antes de tirar conclusão de ausência — uma
 * varredura que devolve zero arquivos deixa qualquer uma destas asserções
 * verde sem ter olhado nada.
 *
 * ─── O que NÃO cobre ────────────────────────────────────────────────────────
 *
 * `supabase/baseline.sql` e as migrations continuam com `confidence_threshold`
 * no default do jsonb de `ai_agents.config`: é dado já gravado em base de
 * cliente, não o controle, e mexer ali é migration (fora do alcance da issue).
 * O Zod já descarta a chave que não conhece — é o mesmo destino de
 * `sentiment_threshold`, que também está no default do banco e em nenhum
 * formulário.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { DICIONARIO } from "@/lib/i18n/dicionario";

import { arquivosDeCodigo, caminhoRelativo, RAIZ_DO_REPO } from "./helpers/varrer-codigo";

/** A agulha é montada em pedaços: ESTE arquivo tem de poder nomear o que
 * proíbe sem passar a ser ele próprio uma referência que a varredura encontre. */
const AGULHA = ["confidence", "_threshold"].join("");
const ROTULO_MORTO = "Confidence threshold";
const PROMESSA_MORTA = "escala para humano";

/** Código que o produto EXECUTA — `arquivosDeCodigo` já descarta `.test.`. */
const RAIZES = ["lib", "components", "app", "workers", "scripts", "hooks"] as const;

const EDITOR = path.join(RAIZ_DO_REPO, "components", "ai", "AgentEditor.tsx");
const SCHEMA = path.join(RAIZ_DO_REPO, "lib", "ai", "guardrails-schema.ts");
const WORKER = path.join(RAIZ_DO_REPO, "workers", "ai-response-worker.ts");

function ondeAparece(agulha: string): string[] {
  return arquivosDeCodigo(RAIZES)
    .filter((arquivo) => readFileSync(arquivo, "utf8").includes(agulha))
    .map(caminhoRelativo);
}

function ler(caminho: string): string {
  return readFileSync(caminho, "utf8");
}

describe("a varredura enxerga o código (controle do instrumento)", () => {
  it("acha o editor, o schema e o worker — e acha a agulha quando ela existe", () => {
    const fontes = arquivosDeCodigo(RAIZES);
    expect(
      fontes.length,
      "varredura devolveu poucos arquivos — instrumento morto?",
    ).toBeGreaterThan(200);
    const relativos = new Set(fontes.map(caminhoRelativo));
    expect(relativos).toContain("components/ai/AgentEditor.tsx");
    expect(relativos).toContain("lib/ai/guardrails-schema.ts");
    expect(relativos).toContain("workers/ai-response-worker.ts");

    // Sem isto, uma agulha mal montada passaria a afirmar ausência sem nunca
    // ter sido capaz de achar a presença.
    expect(`config: { ${AGULHA}: 0 }`.includes(AGULHA)).toBe(true);

    // E a prova de presença tem de ser com uma chave que FICA: `rag_similarity_`
    // `_threshold` é o vizinho de mesma safra que continua com consumidor de
    // verdade (editor, schema, engine). Se a varredura parar de achá-la, o
    // "nenhuma referência" lá embaixo volta a ser verde sem ter olhado nada.
    const vivas = ondeAparece(["rag", "_similarity_threshold"].join(""));
    expect(vivas, "a varredura não acha nem uma chave que está no produto").toContain(
      "components/ai/AgentEditor.tsx",
    );
    expect(vivas).toContain("lib/ai/guardrails-schema.ts");
  });
});

describe("o controle Confidence threshold sumiu do código que o produto executa", () => {
  it("nenhum código de produção nem script lê ou escreve a chave", () => {
    expect(
      ondeAparece(AGULHA),
      "referência órfã: a chave não tem mais formulário nem leitor vivo — " +
        "quem a lê agora lê uma configuração que ninguém consegue configurar",
    ).toEqual([]);
  });

  it("o editor não oferece o campo nem o rótulo em inglês", () => {
    const editor = ler(EDITOR);
    expect(editor).not.toContain(AGULHA);
    expect(editor).not.toContain(ROTULO_MORTO);
  });

  it("o schema do formulário não declara a chave (nem defaults, nem patch)", () => {
    expect(ler(SCHEMA)).not.toContain(AGULHA);
  });

  it("a aba RAG não promete mais escalar para humano", () => {
    // O rótulo some, mas a PROMESSA é o que engana: é ela que fica se alguém
    // apagar só o input e deixar a frase de ajuda.
    expect(ler(EDITOR)).not.toContain(PROMESSA_MORTA);
  });
});

describe("o que tinha de continuar, continua", () => {
  it("a frase da aba RAG existe e tem espanhol no dicionário", () => {
    // Trocar a copy sem traduzir derruba a tela do espanhol para português
    // (`i18n-espanhol-cobre-a-tela` reprovaria, mas aqui o teste deixa o
    // acoplamento explícito: a régua desta issue é a mesma frase).
    const editor = ler(EDITOR);
    const frases = [...editor.matchAll(/t\(\s*"([^"]{10,})"/g)].map((m) => m[1] as string);
    const fraseDaAbaRag = frases.find((f) => f.startsWith("Top K = "));
    expect(fraseDaAbaRag, "a aba RAG perdeu a frase que explica os campos").toBeDefined();
    expect(fraseDaAbaRag).not.toContain(PROMESSA_MORTA);
    expect(fraseDaAbaRag).not.toContain("Confidence");
    expect(
      DICIONARIO[fraseDaAbaRag as keyof typeof DICIONARIO]?.es,
      "frase nova sem espanhol — a tela cai para o português de quem escolheu espanhol",
    ).toBeTruthy();
  });

  it("o worker legado mantém o skip que impede o envio órfão", () => {
    // Remover o controle não pode virar religar o worker: o skip em
    // `elegivelParaWorkerLegado()` é o que segura o evento de envio sem
    // consumidor. Quem precisar dele de volta tem de conseguir achar o skip.
    const worker = ler(WORKER);
    expect(worker).toContain("if (!elegivelParaWorkerLegado(ctx.agent))");
    expect(worker).toContain("legacy_recovery_required");
    // E o G3 continua existindo como gate — só sem ler uma chave fantasma.
    expect(worker).toContain("checkG3({");
  });
});
