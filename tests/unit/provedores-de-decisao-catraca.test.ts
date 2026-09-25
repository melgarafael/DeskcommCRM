/**
 * A CATRACA: O JEV TEM CHAVE, MAS NUNCA VIRA MODELO DE CONVERSA.
 *
 * O Jev (TypeSafe AI) devolve decisão tipada — nota, escolha, sim/não —, nunca
 * texto. Escolhido como cérebro do agente, como IA da empresa ou como modelo de
 * um ponto de conversa, todo turno morreria em `LlmProviderUnknownError` com a
 * tela dizendo "salvo".
 *
 * A proteção é estrutural: ele mora em `PROVEDORES_DE_DECISAO`, lista IRMÃ de
 * `PROVEDORES`, e toda superfície de conversa deriva de `PROVEDORES`. Este
 * arquivo prova as duas metades:
 *
 *  1. pelo COMPORTAMENTO — cada porta de conversa recusa `typesafe`;
 *  2. pela ESTRUTURA — só as superfícies de CHAVE pedem a união. Quem acrescentar
 *     um consumidor novo dela precisa declará-lo aqui, e a declaração é a hora
 *     de perguntar "esta tela escolhe modelo de conversa?".
 */
import { readFileSync } from "node:fs";

import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

import { createDefaultRegistry } from "@/lib/agent-engine/edge/llm/providers";
import { PROVIDERS, versionCreateSchema } from "@/lib/ai/agents/validation";
import {
  ehProvedorDeDecisao,
  ehProvedorSuportado,
  IDS_COM_CHAVE,
  IDS_DE_PROVEDOR,
  IDS_DE_PROVEDOR_DE_DECISAO,
  PROVEDORES,
  PROVEDORES_DE_DECISAO,
} from "@/lib/ai/pontos/provedores";
import { buildModel } from "@/lib/ai/runtime/agent";
import { POST as reconciliarAgente } from "@/app/api/v1/ai/agents/[id]/reconcile/route";

import { arquivosDeCodigo, caminhoRelativo } from "./helpers/varrer-codigo";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () => ({
    ok: true,
    user: { id: "actor", idioma: "pt-BR" },
    org: { orgId: "11111111-1111-4111-8111-111111111111", role: "admin" },
  }),
}));
// Agente não encontrado: o corpo que PASSA pela validação chega aqui e volta 404.
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    const chain: Record<string, unknown> = { maybeSingle: async () => ({ data: null, error: null }) };
    for (const m of ["from", "select", "eq"]) chain[m] = () => chain;
    return chain;
  },
}));

const DECISAO = PROVEDORES_DE_DECISAO.map((p) => p.id);

function reconciliar(provider: string) {
  return reconciliarAgente(
    new NextRequest("http://localhost/api/v1/ai/agents/x/reconcile", {
      method: "POST",
      body: JSON.stringify({
        channel_id: "22222222-2222-4222-8222-222222222222",
        provider,
        model: "jev-1.13.0",
        credential_id: null,
      }),
    }),
    { params: Promise.resolve({ id: "33333333-3333-4333-8333-333333333333" }) },
  );
}

describe("o Jev está declarado como provedor de decisão (controle positivo)", () => {
  it("a lista irmã tem o Jev, e a união o inclui", () => {
    // Sem isto, os casos de recusa abaixo passariam por vacuidade.
    expect(DECISAO).toContain("typesafe");
    expect(IDS_DE_PROVEDOR_DE_DECISAO).toContain("typesafe");
    expect(IDS_COM_CHAVE).toContain("typesafe");
    expect(ehProvedorDeDecisao("typesafe")).toBe(true);
    expect(ehProvedorDeDecisao("anthropic")).toBe(false);
  });

  it("a união é exatamente as duas listas, sem sobreposição", () => {
    const linguagem = PROVEDORES.map((p) => p.id as string);
    expect(DECISAO.filter((id) => linguagem.includes(id))).toEqual([]);
    expect([...IDS_COM_CHAVE].sort()).toEqual([...linguagem, ...DECISAO].sort());
  });
});

describe.each(DECISAO)("%s nunca é modelo de conversa", (id) => {
  it("não está na lista de quem conversa", () => {
    expect(PROVEDORES.map((p) => p.id as string)).not.toContain(id);
    expect([...IDS_DE_PROVEDOR] as string[]).not.toContain(id);
    // É o gate do PUT (modelo de um ponto), do PATCH (Modelo padrão da empresa)
    // e da rota de catálogo de modelos, em app/api/v1/ai/providers/.
    expect(ehProvedorSuportado(id)).toBe(false);
  });

  it("o registry de produção não sabe instanciá-lo como LanguageModel", () => {
    expect(createDefaultRegistry()[id]).toBeUndefined();
  });

  it("o runtime de ensaio (aba Teste do agente) o recusa", () => {
    expect(() => buildModel(id, "k", "jev-1.13.0")).toThrow(/unsupported_provider/);
  });

  it("o schema de versão de agente o recusa", () => {
    expect([...PROVIDERS] as string[]).not.toContain(id);
    const r = versionCreateSchema.safeParse({
      system_prompt: "Você é um atendente útil e cordial.",
      provider: id,
      model: "jev-1.13.0",
      credential_id: null,
      channel_session_id: null,
    });
    expect(r.success).toBe(false);
  });

  it("a reconciliação de agente legado o recusa na validação", async () => {
    expect((await reconciliar(id)).status).toBe(422);
    // Controle positivo: quem conversa passa da validação (e cai no 404 do dublê).
    expect((await reconciliar("anthropic")).status).toBe(404);
  });
});

describe("só as superfícies de CHAVE pedem a união", () => {
  const SIMBOLOS_DA_UNIAO =
    /\b(PROVEDORES_COM_CHAVE|IDS_COM_CHAVE|PROVEDORES_DE_DECISAO|IDS_DE_PROVEDOR_DE_DECISAO|ProvedorComChave|ehProvedorDeDecisao)\b/;

  /**
   * Cada linha é uma decisão escrita: este arquivo lida com CHAVE (cadastrar,
   * validar, listar, girar) ou com o próprio Jev — nunca escolhe modelo de
   * conversa. Arquivo novo aqui exige a mesma resposta.
   */
  const DECLARADOS = [
    "lib/ai/pontos/provedores.ts", // onde as listas nascem
    "lib/ai/provider-validators.ts", // valida a chave de qualquer natureza
    "lib/ai/log-invocation.ts", // grava o provedor da chamada, inclusive o Jev
    "lib/ai/decisao/credencial.ts", // qual chave do Jev está em uso
    "app/api/v1/ai/jev/route.ts", // o cartão do próprio Jev
    "app/api/v1/ai/credentials/route.ts", // cadastra a chave
    "hooks/ai/useCredentials.ts", // tipo da LINHA de credencial
    "app/api/v1/ai/credentials/[id]/route.ts", // gira a chave (o provedor não muda)
    "lib/ai/credenciais/guardar.ts", // cifra, grava e valida a chave de qualquer natureza
    // decifra a credencial pelo id; o runtime que a usa recusa o Jev em buildModel
    "lib/ai/credentials.ts",
    "app/app/ai/credentials/_components/AddCredentialDialog.tsx",
    "app/app/ai/credentials/_components/CredentialCard.tsx",
    "app/app/ai/credentials/_components/CredentialsList.tsx",
    "app/app/ai/credentials/_components/RotateCredentialDialog.tsx",
  ].sort();

  const usam = arquivosDeCodigo(["app", "lib", "components", "hooks", "workers"])
    .map(caminhoRelativo)
    .filter((caminho) => SIMBOLOS_DA_UNIAO.test(readFileSync(caminho, "utf8")))
    .sort();

  it("a varredura enxerga o código (controle positivo)", () => {
    expect(usam).toContain("lib/ai/pontos/provedores.ts");
  });

  it("ninguém fora da lista declarada usa a união", () => {
    expect(
      usam.filter((c) => !DECLARADOS.includes(c)),
      "arquivo novo pediu a lista que inclui o Jev. Se ele escolhe modelo de CONVERSA, use PROVEDORES; " +
        "se lida só com chave, declare-o aqui com a razão",
    ).toEqual([]);
  });

  it("ninguém dá outro nome à união (o apelido escaparia da varredura)", () => {
    // Já aconteceu: `export type Provider = ProvedorComChave` em
    // provider-validators.ts. Quem importava `Provider` de lá levava a união sem
    // citar nenhum símbolo acima — e `Provider` em hooks/ai/useCredentials.ts
    // quer dizer o CONTRÁRIO (só quem conversa).
    // Três formas: `type X = …`, `export const X = <lista>` (apelido de VALOR,
    // que um arquivo declarado reexportaria) e `<símbolo> as X`.
    const APELIDO =
      /\btype\s+\w+(?:<[^>]*>)?\s*=[^;]*\b(?:ProvedorComChave|PROVEDORES_COM_CHAVE|IDS_COM_CHAVE|PROVEDORES_DE_DECISAO|IDS_DE_PROVEDOR_DE_DECISAO)\b|\bexport\s+(?:const|let)\s+\w+\s*(?::[^=]+)?=\s*(?:PROVEDORES_COM_CHAVE|IDS_COM_CHAVE|PROVEDORES_DE_DECISAO|IDS_DE_PROVEDOR_DE_DECISAO)\b|\b(?:ProvedorComChave|PROVEDORES_COM_CHAVE|IDS_COM_CHAVE|PROVEDORES_DE_DECISAO|IDS_DE_PROVEDOR_DE_DECISAO)\s+as\s+\w+/;
    // Controle: a régua pega as três formas, e não o `const` local de um card.
    for (const apelido of [
      "export type Provider = ProvedorComChave;",
      "export const TODOS = PROVEDORES_COM_CHAVE;",
      "export { PROVEDORES_DE_DECISAO as X };",
    ]) {
      expect(APELIDO.test(apelido), apelido).toBe(true);
    }
    expect(APELIDO.test("const provedor = PROVEDORES_COM_CHAVE.find((p) => p.id === x);")).toBe(false);
    const apelidam = usam.filter(
      (c) => c !== "lib/ai/pontos/provedores.ts" && APELIDO.test(readFileSync(c, "utf8")),
    );
    expect(apelidam, "use o nome da lista (ProvedorComChave), não um apelido").toEqual([]);
  });

  it("toda declaração ainda é verdade (a lista não apodrece)", () => {
    expect(DECLARADOS.filter((c) => !usam.includes(c))).toEqual([]);
  });

  it("as telas que escolhem modelo de conversa derivam de PROVEDORES", () => {
    // O passo "Qual você contratou" grava a IA da EMPRESA INTEIRA; o seletor do
    // agente escolhe o cérebro do atendimento. Os dois derivam da lista de
    // quem conversa — e o gate da Server Action é o mesmo IDS_DE_PROVEDOR.
    for (const caminho of [
      "app/onboarding/setup-ai/_inteligencia.tsx",
      "app/app/ai/agents/[id]/_components/AgentForm.tsx",
      "app/actions/onboarding/chaveDaIa.ts",
    ]) {
      const fonte = readFileSync(caminho, "utf8");
      expect(fonte, caminho).toMatch(/\b(PROVEDORES|IDS_DE_PROVEDOR)\b/);
      expect(SIMBOLOS_DA_UNIAO.test(fonte), caminho).toBe(false);
    }
  });
});
