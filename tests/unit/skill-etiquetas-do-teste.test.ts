/**
 * O BOTÃO TESTAR ACEITA ETIQUETAS SIMULADAS — spec 27, fatia 3.
 *
 * O defeito: a prévia do Testar devolvia `[]` como etiquetas do matcher. Uma skill que entra
 * só pela etiqueta nunca entrava no teste, e o operador não tinha como ver o que ela faz.
 *
 * Aqui prova-se o que cabe sem banco:
 *   - o schema do teste aceita `sample_tags`, normaliza como o CRM e recusa mais de 20;
 *   - sem `sample_tags` o schema sai como antes (nenhuma chave nova);
 *   - a prévia que traz `tags` entrega essas etiquetas ao matcher, e a prévia sem `tags`
 *     continua sem etiqueta nenhuma.
 *
 * O casamento completo (prévia com `sample_tags: ['estetica']` casa `any_tags: ['estetica']`
 * e o traço mostra) é provado pela tela, como leigo, e não por este arquivo.
 */
import { describe, expect, it, vi } from "vitest";

import { testRunSchema } from "@/lib/ai/agents/validation";
import { etiquetasParaOMatcher } from "@/lib/agent-engine/agent/etiquetas-do-matcher";
import type { TurnPreview } from "@/lib/agent-engine/agent/preview";
import type { LoadedSkill } from "@/lib/agent-engine/agent/skills";
import type { Logger } from "@/lib/agent-engine/obs/logger";

const mensagem = { sample_message: "quero um orçamento" };

const logFalso = () =>
  ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }) as unknown as Logger;

const skillDeEtiqueta: LoadedSkill = {
  versionId: "v-odonto",
  name: "odonto",
  description: "d",
  body: "corpo",
  matcher: { any_keywords: ["nunca-aparece"], any_tags: ["estetica"] },
  manifest: [],
};

describe("testRunSchema aceita as etiquetas simuladas", () => {
  it("sem sample_tags o schema sai como antes: nenhuma chave nova", () => {
    const parsed = testRunSchema.parse(mensagem);
    expect("sample_tags" in parsed).toBe(false);
  });

  it("normaliza como o CRM guarda: minúscula, sem espaço, sem repetida", () => {
    expect(testRunSchema.parse({ ...mensagem, sample_tags: [" Estetica ", "estetica", "VIP"] })).toMatchObject({
      sample_tags: ["estetica", "vip"],
    });
  });

  it("aceita até 20 e recusa a 21ª", () => {
    const vinte = Array.from({ length: 20 }, (_, i) => `tag${i}`);
    expect(testRunSchema.safeParse({ ...mensagem, sample_tags: vinte }).success).toBe(true);
    expect(
      testRunSchema.safeParse({ ...mensagem, sample_tags: [...vinte, "tag20"] }).success,
    ).toBe(false);
  });

  it("continua fechado: campo a mais é recusado", () => {
    expect(testRunSchema.safeParse({ ...mensagem, organization_id: "x" }).success).toBe(false);
  });
});

describe("a prévia entrega as etiquetas simuladas ao matcher", () => {
  const previaCom = (extra: Partial<TurnPreview>) => ({ ...extra }) as unknown as TurnPreview;
  const poolQueNaoDeveSerConsultado = () => ({ query: vi.fn() }) as never;

  it("prévia com tags: o matcher recebe exatamente as etiquetas simuladas, sem consultar o banco", async () => {
    const pool = poolQueNaoDeveSerConsultado();
    const out = await etiquetasParaOMatcher(
      pool,
      "org-1",
      "conv-1",
      [skillDeEtiqueta],
      previaCom({ tags: ["estetica"] }),
      logFalso(),
    );
    expect(out).toEqual(["estetica"]);
    expect((pool as { query: ReturnType<typeof vi.fn> }).query).not.toHaveBeenCalled();
  });

  it("prévia sem tags (o Testar sem etiqueta simulada): lista vazia, como antes", async () => {
    const out = await etiquetasParaOMatcher(
      poolQueNaoDeveSerConsultado(),
      "org-1",
      "conv-1",
      [skillDeEtiqueta],
      previaCom({}),
      logFalso(),
    );
    expect(out).toEqual([]);
  });
});
