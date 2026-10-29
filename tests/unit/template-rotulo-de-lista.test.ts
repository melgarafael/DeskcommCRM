/**
 * `{{campo}}` DE LISTA SAI COM O RÓTULO DA OPÇÃO (#3605).
 *
 * O defeito medido na 1.94: o card de um campo `searchable_select` guarda o
 * `value` canônico da opção (`paris-franca`), e o render do template devolvia
 * esse valor CRU — o cliente recebia "Sua viagem para paris-franca está
 * chegando". O texto de reserva (`{{destino|"a definir"}}`) não cobre isto: ele
 * só entra quando o valor está VAZIO.
 *
 * A régua que estes casos trancam, uma linha cada:
 *
 *   - lista simples → rótulo da opção;
 *   - múltipla escolha → rótulos unidos por ", " (o separador que o domínio já
 *     usa em `valorLegivel`, lib/leads/compras-do-contato.ts:88);
 *   - valor sem opção correspondente (opção removida da lista depois de
 *     gravada) → o VALOR, nunca vazio: apagar o dado é pior que mostrar o
 *     código;
 *   - campo que não é lista → byte a byte igual;
 *   - vazio → a reserva de sempre;
 *   - contexto sem as definições → o valor, como antes (nada quebra).
 *
 * O último bloco é a RESPOSTA RÁPIDA pelo caminho de verdade
 * (`preencherModeloDeMensagem`), porque o renderizador é um só: consertar a
 * automação e deixar a resposta rápida no código seria o mesmo defeito com
 * outro nome.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Actor } from "@/lib/api/handlers/types";
import { renderTemplate } from "@/lib/automation/template";
import type { DepsDaOperacao } from "@/lib/operacao/entradas-automaticas";
import { preencherModeloDeMensagem } from "@/lib/operacao/modelos-de-mensagem";
import type { CustomFieldDef } from "@/lib/schemas/settings";
import { ORG_ID, PIPE, USER_ID, funilRow, makeDb, negocio } from "@/tests/helpers/stages-db-double";

/**
 * A chave em que o `context` carrega as definições do funil.
 *
 * Fora do alfabeto da marcação (`[\w.]`) de propósito: `{{campos-do-funil}}` não
 * é um token, então o mapa de rótulos nunca vira variável de mensagem.
 */
const CAMPOS_DO_FUNIL_NO_CONTEXTO = "campos-do-funil";

/** A lista do exemplo da issue: destinos gravados como código. */
const DESTINO: CustomFieldDef = {
  key: "destino",
  label: "Destino",
  type: "searchable_select",
  options: [
    { value: "paris-franca", label: "Paris (França)" },
    { value: "fortaleza-ce", label: "Fortaleza (CE)" },
    { value: "porto-de-galinhas-pe", label: "Porto de Galinhas (PE)" },
  ],
};

/** Múltipla escolha (#3182): o card grava uma LISTA de códigos. */
const FORNECEDORES: CustomFieldDef = {
  key: "fornecedores",
  label: "Fornecedores",
  type: "searchable_select",
  multiple: true,
  options: [
    { value: "aereo-a", label: "Aéreo A" },
    { value: "hotel-b", label: "Hotel B" },
  ],
};

const CAMPOS: CustomFieldDef[] = [
  DESTINO,
  FORNECEDORES,
  { key: "roteiro", label: "Roteiro", type: "textarea" },
  { key: "pessoas", label: "Pessoas", type: "number" },
  { key: "guia", label: "Guia", type: "boolean" },
];

/** O `context` como a automação o monta: `{ lead }` + as definições do funil. */
function contexto(
  custom_fields: Record<string, unknown>,
  campos: CustomFieldDef[] = CAMPOS,
): Record<string, unknown> {
  return {
    contact: { name: "Ana" },
    lead: { id: "l1", pipeline_id: "p1", custom_fields },
    [CAMPOS_DO_FUNIL_NO_CONTEXTO]: campos,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("lista simples: sai o rótulo, não o código (#3605)", () => {
  it("⭐ `{{destino}}` resolve pelo rótulo da opção escolhida", () => {
    const ctx = contexto({ destino: "paris-franca" });
    expect(renderTemplate("Sua viagem para {{destino}} está chegando", ctx)).toBe(
      "Sua viagem para Paris (França) está chegando",
    );
  });

  it("o caminho longo `{{lead.custom_fields.destino}}` também usa o rótulo", () => {
    const ctx = contexto({ destino: "fortaleza-ce" });
    expect(renderTemplate("Destino: {{lead.custom_fields.destino}}", ctx)).toBe(
      "Destino: Fortaleza (CE)",
    );
  });

  it("a mesma opção em dois lugares do texto sai com o rótulo nas duas", () => {
    const ctx = contexto({ destino: "porto-de-galinhas-pe" });
    expect(renderTemplate("{{destino}} — de novo: {{destino}}", ctx)).toBe(
      "Porto de Galinhas (PE) — de novo: Porto de Galinhas (PE)",
    );
  });
});

describe("múltipla escolha: os rótulos unidos pelo separador do domínio", () => {
  it("⭐ `multiple: true` sai com os rótulos separados por vírgula", () => {
    const ctx = contexto({ fornecedores: ["aereo-a", "hotel-b"] });
    expect(renderTemplate("Comprado com {{fornecedores}}", ctx)).toBe(
      "Comprado com Aéreo A, Hotel B",
    );
  });

  it("código fora da lista no meio da múltipla escolha sai como veio, sem sumir", () => {
    const ctx = contexto({ fornecedores: ["aereo-a", "operadora-removida"] });
    expect(renderTemplate("{{fornecedores}}", ctx)).toBe("Aéreo A, operadora-removida");
  });
});

describe("o que NÃO pode mudar", () => {
  it("valor sem opção correspondente (opção removida) sai como o valor, nunca vazio", () => {
    const ctx = contexto({ destino: "gramado-rs" });
    expect(renderTemplate("Destino: {{destino}}", ctx)).toBe("Destino: gramado-rs");
  });

  it("campo de texto comum passa igual", () => {
    const ctx = contexto({ roteiro: "7 dias, 6 noites" });
    expect(renderTemplate("Roteiro: {{roteiro}}", ctx)).toBe("Roteiro: 7 dias, 6 noites");
  });

  it("número e booleano continuam como estavam", () => {
    const ctx = contexto({ pessoas: 3, guia: true });
    expect(renderTemplate("{{pessoas}} pessoas, guia: {{guia}}", ctx)).toBe(
      "3 pessoas, guia: true",
    );
  });

  it("campo vazio continua usando a reserva da variável", () => {
    const ctx = contexto({ destino: "" });
    expect(renderTemplate('Destino: {{destino|"a definir"}}', ctx)).toBe("Destino: a definir");
  });

  it("com valor, a reserva é ignorada e o rótulo entra", () => {
    const ctx = contexto({ destino: "paris-franca" });
    expect(renderTemplate('Destino: {{destino|"a definir"}}', ctx)).toBe("Destino: Paris (França)");
  });

  it("alias `{{nome}}` não é sequestrado por campo personalizado de mesmo nome", () => {
    // O funil TEM um campo `nome`; o texto pediu o nome da PESSOA. Se o mapa de
    // rótulos fosse aplicado por cima do alias, "Ana" viraria o rótulo de uma
    // opção chamada "Ana" — ou o código, quando não houvesse opção.
    const campos: CustomFieldDef[] = [
      {
        key: "nome",
        label: "Nome do pacote",
        type: "select",
        options: [{ value: "Ana", label: "Pacote Ana" }],
      },
    ];
    const ctx = contexto({ nome: "Ana" }, campos);
    expect(renderTemplate("Oi {{nome}}", ctx)).toBe("Oi Ana");
  });

  it("contexto SEM as definições (quem chama não hidratou) sai como antes: o valor", () => {
    const semDefinicoes = { lead: { custom_fields: { destino: "paris-franca" } } };
    expect(renderTemplate("{{destino}}", semDefinicoes)).toBe("paris-franca");
  });

  it("lista sem as definições continua saindo separada por vírgula (o join de antes)", () => {
    const semDefinicoes = { lead: { custom_fields: { interesses: ["a", "b"] } } };
    expect(renderTemplate("{{interesses}}", semDefinicoes)).toBe("a, b");
  });

  it("definição de funil sem `options` não inventa rótulo", () => {
    const campos: CustomFieldDef[] = [{ key: "destino", label: "Destino", type: "text" }];
    const ctx = contexto({ destino: "paris-franca" }, campos);
    expect(renderTemplate("{{destino}}", ctx)).toBe("paris-franca");
  });
});

describe("resposta rápida: o MESMO renderizador, com as definições hidratadas", () => {
  const PESSOA: Actor = { type: "user", id: USER_ID, role: "agent" };

  function deps(db: ReturnType<typeof makeDb>): DepsDaOperacao {
    return {
      supabase: db.client as unknown as SupabaseClient,
      organizationId: ORG_ID,
      actor: PESSOA,
      requestId: "req-3605",
    };
  }

  /** O banco do caminho de verdade: modelo, negócio com o código, funil com a lista. */
  function comModeloELista(corpo: string) {
    const db = makeDb({
      leads: [
        negocio("l1", "e1", {
          title: "Viagem Paris",
          value_cents: 0,
          currency: "BRL",
          contact_id: "c1",
          pipeline_id: PIPE,
          custom_fields: { destino: "paris-franca" },
        }),
      ],
      pipelines: [
        funilRow({
          id: PIPE,
          name: "Viagens",
          settings: { fields: [DESTINO] },
        }),
      ],
      contacts: [
        { id: "c1", organization_id: ORG_ID, name: "Ana", phone_number: "+5511", email: null },
      ],
    });
    (db.tabelas as unknown as Record<string, unknown[]>).message_templates = [
      {
        id: "t1",
        organization_id: ORG_ID,
        owner_user_id: null,
        title: "Boas-vindas",
        body: corpo,
        shortcut: null,
      },
    ];
    return db;
  }

  it("⭐ a resposta rápida sai com o rótulo, não com o código", async () => {
    const db = comModeloELista("Sua viagem para {{destino}} está chegando");
    const r = await preencherModeloDeMensagem(deps(db), { templateId: "t1", leadId: "l1" });
    expect(r.texto).toBe("Sua viagem para Paris (França) está chegando");
    expect(r.lacunas).toEqual([]);
  });

  it("a reserva da variável continua valendo na resposta rápida quando o campo está vazio", async () => {
    const db = comModeloELista('Destino: {{destino|"a definir"}}');
    (db.tabelas.crm_leads[0] as Record<string, unknown>).custom_fields = { destino: "" };
    const r = await preencherModeloDeMensagem(deps(db), { templateId: "t1", leadId: "l1" });
    expect(r.texto).toBe("Destino: a definir");
    expect(r.lacunas).toEqual([]);
  });
});
