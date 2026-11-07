/**
 * O PREFIXO ESTÁVEL NÃO MUDA UM BYTE SEM ALGUÉM VER.
 *
 * `serializeStablePrefix` é a visão canônica do prefixo que o provedor recebe
 * (ferramentas em ordem de nome, depois o sistema). Dela saem o hash de
 * `stablePrefixHash` e, desde a medição da composição, as colunas
 * `chars_ferramentas` e `prefixo_hash` de `llm_calls` — que comparam o "antes" e
 * o "depois" de toda economia de tokens. Se a serialização mudar em silêncio, a
 * régua muda junto e a comparação mede a régua, não a economia.
 *
 * Os dois LITERAIS abaixo foram capturados uma vez no módulo intacto (o teste
 * rodou com um valor de enchimento e o valor real saiu da mensagem de falha).
 * Eles são o oráculo: não dependem da implementação que vigiam.
 *
 * Recapturados em 2026-10-31, quando o `$schema` saiu do esquema no fio
 * (`esquemaParaOProvedor`): 584 → 532 caracteres, exatamente os 52 de
 * `"$schema":"http://json-schema.org/draft-07/schema#",` da ferramenta zod (a de
 * `jsonSchema()` nunca o teve). Mudança de prefixo deliberada — o cache de cada
 * agente recomeça uma vez no deploy — e é este teste que a torna visível.
 *
 * Substitui o `llm-cache.test.ts` que o cabeçalho de `stable-prefix.ts` citava e
 * que nunca existiu.
 */
import { jsonSchema, tool } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { serializeStablePrefix, stablePrefixHash } from "@/lib/agent-engine/edge/llm/stable-prefix";

/** O insumo fixo. `composicao.test.ts` repete o MESMO, e o mesmo literal. */
function insumoGolden() {
  return {
    system: "Você atende a Loja Exemplo. Responda em português, com frases curtas.",
    tools: {
      // Fora de ordem de propósito: a serialização ordena por nome.
      salvar_nota: tool({
        description: "Salva uma nota sobre o lead.",
        inputSchema: z.object({ titulo: z.string(), corpo: z.string().max(500) }),
      }),
      buscar_produto: tool({
        description: "Busca um produto no catálogo.",
        inputSchema: jsonSchema({
          type: "object",
          properties: { termo: { type: "string" } },
          required: ["termo"],
          additionalProperties: false,
        }),
      }),
    },
  };
}

const HASH_GOLDEN = "18075b5218335a03ba6363128b064f0898f150135e910f6aa6cd283e5bc318a4";
const TAMANHO_GOLDEN = 532;

describe("prefixo estável — caracterização byte a byte", () => {
  it("o hash do insumo fixo é o literal capturado no módulo intacto", async () => {
    expect(await stablePrefixHash(insumoGolden())).toBe(HASH_GOLDEN);
  });

  it("o tamanho da serialização é o literal capturado no módulo intacto", async () => {
    expect((await serializeStablePrefix(insumoGolden())).length).toBe(TAMANHO_GOLDEN);
  });

  it("dois builds do mesmo insumo dão o mesmo hash", async () => {
    expect(await stablePrefixHash(insumoGolden())).toBe(await stablePrefixHash(insumoGolden()));
  });
});
