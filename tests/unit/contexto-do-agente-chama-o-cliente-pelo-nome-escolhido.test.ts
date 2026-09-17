import { describe, expect, it } from "vitest";

import { getLeadContext } from "@/lib/agent-engine/edge/crm/get-lead-context";

/**
 * O MOTOR VIVO CHAMA O CLIENTE PELO NOME QUE ALGUÉM ESCOLHEU.
 *
 * A issue #906 converteu nove pontos de uso para `nomeDoContato`, e o único que
 * ganhou teste de comportamento foi `renderSystemPrompt`. Medido: `git grep
 * renderSystemPrompt` devolve DOIS arquivos — a definição e
 * `workers/ai-response-worker.ts`. Ou seja, a guarda existente cobre o worker
 * LEGADO; o caminho que atende de verdade, o `agent-engine`, resolve o nome
 * aqui, em `getLeadContext`, e estava guardado só pelo typecheck — que não vê
 * diferença nenhuma entre `nomeDoContato(contact)` e `contact.display_name ??
 * contact.name`.
 *
 * O que este arquivo protege não é uma tela: é a PRIMEIRA LINHA que o modelo lê
 * sobre com quem está falando. Um `Contato 543134@lid` aqui vira vocabulário de
 * máquina na boca do agente, com o cliente lendo do outro lado.
 *
 * O dublê responde por SQL: a consulta de contato é a primeira do fluxo e é a
 * única que este arquivo precisa reger.
 */

const KNOBS = { historyLimit: 20, maxTokens: 1_000 };
const ENTRADA = { tenantId: "org-1", leadId: "contato-1", fuso: "America/Sao_Paulo" };

/** O banco como `getLeadContext` o lê: uma linha de `contacts`, nada mais. */
function bancoCom(perfil: { name: string | null; display_name: string | null }) {
  return {
    query: async (sql: string) => {
      if (sql.includes("from contacts")) {
        return {
          rows: [
            {
              ...perfil,
              email: null,
              phone_number: "+5532984793302",
              tags: [],
              is_blocked: false,
              source: "whatsapp",
              consent: null,
              is_anonymized: false,
            },
          ],
        };
      }
      // conversations / crm_lead_activities / messages / demandas
      return { rows: [] };
    },
  };
}

async function nomeNoContexto(perfil: { name: string | null; display_name: string | null }) {
  const r = await getLeadContext(bancoCom(perfil) as never, {} as never, ENTRADA, KNOBS);
  if (!r.ok) throw new Error("o contexto do turno falhou");
  return r.context.contact.name;
}

describe("o contexto do turno chama o cliente pelo nome escolhido", () => {
  it("o nome da ficha vence o do perfil do WhatsApp", async () => {
    expect(await nomeNoContexto({ name: "Kaio Gomes", display_name: "🌸 Kaio" })).toBe("Kaio Gomes");
  });

  it("sem nome na ficha, o do perfil do WhatsApp aparece — não some", async () => {
    // A metade que a inversão de precedência não pode custar: contato que entra
    // pelo WhatsApp nasce só com `display_name`, e nesta instalação eram 15 de 33.
    expect(await nomeNoContexto({ name: null, display_name: "Kaio" })).toBe("Kaio");
  });

  it("identificador técnico não vira nome de gente — o modelo recebe null", async () => {
    // `null` é a resposta CERTA, não uma falha: quem chama decide o fallback, e
    // quem FALA com a pessoa não pode cair no telefone. Um `contact.name ??
    // contact.display_name` cru passaria nos dois casos acima e morreria aqui.
    expect(await nomeNoContexto({ name: null, display_name: "Contato 543134@lid" })).toBeNull();
  });

  it("identificador técnico na FICHA não trava a cadeia: o perfil assume", async () => {
    // A guarda não é "o primeiro não-nulo". Resíduo de ingestão já foi parar na
    // coluna editável, e nesse caso o nome do perfil é o melhor que existe.
    expect(await nomeNoContexto({ name: "543134@lid", display_name: "Kaio" })).toBe("Kaio");
  });
});
