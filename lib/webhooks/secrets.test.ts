/**
 * O segredo de um `call_webhook` DENTRO de uma opção do `ai_decide` (#1970) é
 * cifrado como o de topo — senão ia aberto para o jsonb da regra e voltava em
 * todo `select("*")` da lista de regras.
 */
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { encryptRuleActionSecrets } from "@/lib/webhooks/secrets";

const SEGREDO = "segredo-de-teste-nao-use";

function adminComCifra(disponivel = true): SupabaseClient {
  return {
    rpc: async (fn: string) =>
      fn === "fn_encrypt_oauth" && disponivel
        ? { data: "\\xc1f7a00", error: null }
        : { data: null, error: { message: "sem chave" } },
  } as unknown as SupabaseClient;
}

const aiDecideComWebhook = () => ({
  type: "ai_decide",
  config: {
    custo_de_token: true,
    instrucao: "Se pediu orçamento, avisa o ERP; senão, etiqueta.",
    opcoes: [
      { id: "erp", rotulo: "Avisar o ERP", acao: { type: "call_webhook", config: { url: "https://erp.test/hook", secret: SEGREDO } } },
      { id: "tag", rotulo: "Etiquetar", acao: { type: "add_tag", config: { tags: ["frio"] } } },
    ],
  },
});

describe("encryptRuleActionSecrets desce nas opções do ai_decide", () => {
  it("o segredo da opção sai cifrado e o texto aberto não sobra em lugar nenhum", async () => {
    const out = await encryptRuleActionSecrets(adminComCifra(), [aiDecideComWebhook()]);

    expect(out).not.toBeNull();
    expect(JSON.stringify(out)).not.toContain(SEGREDO);
    const opcoes = out![0]!.config!.opcoes as Array<{ acao: { config: Record<string, unknown> } }>;
    expect(opcoes[0]!.acao.config).toEqual({ url: "https://erp.test/hook", secret_enc: "c1f7a00" });
    expect(opcoes[1]!.acao.config).toEqual({ tags: ["frio"] });
  });

  it("sem a chave de cifra, recusa a regra inteira (a rota responde 422) em vez de gravar aberto", async () => {
    expect(await encryptRuleActionSecrets(adminComCifra(false), [aiDecideComWebhook()])).toBeNull();
  });
});
