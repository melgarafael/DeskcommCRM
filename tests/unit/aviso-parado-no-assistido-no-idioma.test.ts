// @vitest-environment node
/**
 * Os dois avisos do assistido (`lib/automation/parada-no-assistido.ts`) — a
 * automação e a sequência paradas — nascem no idioma da ORGANIZAÇÃO, como o
 * aviso de etapa: a Central mostra título e corpo como foram gravados.
 *
 *     pnpm vitest run tests/unit/aviso-parado-no-assistido-no-idioma.test.ts
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it } from "vitest";

import { avisarAcoesParadas, avisarSequenciaParada } from "@/lib/automation/parada-no-assistido";

const ORG = "11111111-1111-4111-8111-111111111111";
const inseridos: Record<string, unknown>[] = [];
const lidos: Array<[string, unknown]> = [];

function admin(locale: string | null): SupabaseClient {
  return {
    from(tabela: string) {
      const q = {
        select: () => q,
        eq: (coluna: string, valor: unknown) => {
          lidos.push([`${tabela}.${coluna}`, valor]);
          return q;
        },
        maybeSingle: async () => ({ data: tabela === "organizations" ? { locale } : null, error: null }),
        insert: async (linha: Record<string, unknown>) => {
          inseridos.push(linha);
          return { error: null };
        },
      };
      return q;
    },
  } as unknown as SupabaseClient;
}

const texto = () => `${String(inseridos[0]!.title)} ${String(inseridos[0]!.body)}`;
/** Palavras que só existem no texto em português destes avisos. */
const PORTUGUES = /aprovação|automação|sequência|inscrição|negócio|ficou parad|mensagem da IA|decisão da IA/;

beforeEach(() => {
  inseridos.length = 0;
  lidos.length = 0;
});

describe("aviso de automação parada no assistido", () => {
  const entrada = {
    organizationId: ORG,
    ruleName: 'Proposta $& "{acoes}"',
    runId: "run-1",
    tipos: ["send_whatsapp_message", "send_email", "send_ai_message", "start_message_flow", "ai_decide"],
  };

  it("organização em espanhol: título e corpo em espanhol, com a regra e as ações", async () => {
    await avisarAcoesParadas(admin("es"), entrada);
    expect(lidos).toContainEqual(["organizations.id", ORG]);
    expect(inseridos[0]!.title).toBe("Automatización esperando aprobación para hablar con el cliente");
    expect(String(inseridos[0]!.body)).toContain('"Proposta $& "{acoes}""');
    expect(String(inseridos[0]!.body)).toContain("(WhatsApp, correo, mensaje de la IA, secuencia, decisión de la IA)");
    expect(texto()).not.toMatch(PORTUGUES);
  });

  it("organização em português (ou sem idioma): o texto de antes", async () => {
    await avisarAcoesParadas(admin(null), { ...entrada, ruleName: "Proposta enviada", tipos: ["send_email"] });
    expect(inseridos[0]!.title).toBe("Automação esperando aprovação para falar com o cliente");
    expect(inseridos[0]!.body).toBe(
      'Uma ação da IA no modo assistido disparou a automação "Proposta enviada", e o que fala com o cliente ficou parado (e-mail). O resto da automação já rodou. Dispare se quiser que a mensagem saia; marque como resolvido para descartar.',
    );
  });
});

describe("aviso de sequência parada no assistido", () => {
  it.each([1, 3])("organização em espanhol, %i sequência(s): tudo em espanhol", async (quantas) => {
    await avisarSequenciaParada(admin("es"), { organizationId: ORG, leadId: "lead-1", quantas });
    expect(inseridos[0]!.title).toBe("Secuencia esperando aprobación para hablar con el cliente");
    expect(String(inseridos[0]!.body)).toContain(quantas === 1 ? "una secuencia" : "3 secuencias");
    expect(texto()).not.toMatch(PORTUGUES);
    expect(texto()).not.toContain("{quantas}");
  });

  it("organização em português: o texto de antes", async () => {
    await avisarSequenciaParada(admin("pt-BR"), { organizationId: ORG, leadId: "lead-1", quantas: 2 });
    expect(inseridos[0]!.title).toBe("Sequência esperando aprovação para falar com o cliente");
    expect(String(inseridos[0]!.body)).toContain("em 2 sequências de follow-up");
  });
});
