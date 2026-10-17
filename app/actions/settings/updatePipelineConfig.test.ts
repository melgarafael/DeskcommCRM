/**
 * Marcar como Contato um campo que o gatilho por data lê (#2791, achado do
 * cético no #3051).
 *
 * A varredura `lead-date-field-due` lê `crm_leads.custom_fields`; o valor de um
 * campo do contato mora em `contacts.custom_fields`. Mudar o escopo nas
 * configurações do funil deixava a regra ligada e muda para sempre. O que se
 * prova: a gravação é recusada com o nome das regras quando há regra ATIVA do
 * gatilho por data, deste funil, lendo a chave — e passa em todo o resto.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const FUNIL = "ffffffff-0000-4000-8000-00000000000f";
const OUTRO_FUNIL = "eeeeeeee-0000-4000-8000-00000000000e";
const ORG = "22222222-2222-4222-8222-222222222222";

const h = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  regras: [] as Array<{ name: string; trigger_config: unknown }>,
  filtrosDasRegras: [] as Array<[string, unknown]>,
  gravou: null as unknown,
  idioma: "pt-BR",
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/impersonate/support", () => ({ supportWriteError: () => null }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: async () => ({
    id: "11111111-1111-4111-8111-111111111111",
    is_platform_admin: false,
    platform_admin_scope: null,
    support: null,
    idioma: h.idioma,
  }),
  resolveActiveOrg: async () => ({ orgId: ORG, role: "admin" }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (tabela: string) => {
      const cadeia: Record<string, unknown> = {};
      if (tabela === "crm_pipelines") {
        cadeia.select = () => cadeia;
        cadeia.eq = () => cadeia;
        cadeia.maybeSingle = async () => ({
          data: { vocabulary: {}, settings: h.settings, organization_id: ORG },
          error: null,
        });
        cadeia.update = (payload: unknown) => {
          h.gravou = payload;
          return { eq: async () => ({ error: null }) };
        };
        return cadeia;
      }
      expect(tabela).toBe("automation_rules");
      // O dublê aplica os filtros de verdade: a regra de outra org, desligada ou
      // de outro gatilho só some se a rota pedir que suma.
      cadeia.select = () => cadeia;
      cadeia.eq = (coluna: string, valor: unknown) => {
        h.filtrosDasRegras.push([coluna, valor]);
        return cadeia;
      };
      cadeia.then = (resolve: (r: unknown) => unknown) => {
        const linhas = h.regras.filter((r) =>
          h.filtrosDasRegras.every(([coluna, valor]) => (r as Record<string, unknown>)[coluna] === valor),
        );
        return Promise.resolve({ data: linhas, error: null }).then(resolve);
      };
      return cadeia;
    },
  }),
}));

import { updatePipelineConfig } from "./updatePipelineConfig";

function regra(name: string, campo: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    organization_id: ORG,
    is_active: true,
    trigger_event: "lead.date_field_due",
    trigger_config: { pipeline_id: FUNIL, campo, dias: 3 },
    ...extra,
  };
}

const NASCIMENTO_NEGOCIO = { key: "nascimento", label: "Nascimento", type: "date" as const };
const NASCIMENTO_CONTATO = { ...NASCIMENTO_NEGOCIO, escopo: "contato" as const };

beforeEach(() => {
  h.settings = { fields: [NASCIMENTO_NEGOCIO] };
  h.regras = [];
  h.filtrosDasRegras = [];
  h.gravou = null;
  h.idioma = "pt-BR";
});

describe("updatePipelineConfig — campo que vira Contato e o gatilho por data", () => {
  it("recusa quando uma regra ATIVA do gatilho por data lê o campo, e nomeia a regra", async () => {
    h.regras = [regra("Parabéns", "nascimento")];

    const r = await updatePipelineConfig(FUNIL, { fields: [NASCIMENTO_CONTATO] });

    expect(r).toEqual({
      ok: false,
      error:
        'A regra "Parabéns" usa no gatilho por data um campo que você marcou como Contato, e o gatilho só lê campos do negócio: ela deixaria de disparar. Troque o campo da regra ou desligue-a antes.',
    });
    expect(h.gravou).toBeNull();
    expect(h.filtrosDasRegras).toContainEqual(["organization_id", ORG]);
  });

  it("o nome da regra sai como foi escrito, mesmo com $& ou $1", async () => {
    h.regras = [regra("Cupom R$& 10 $1", "nascimento")];

    const r = await updatePipelineConfig(FUNIL, { fields: [NASCIMENTO_CONTATO] });

    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('"Cupom R$& 10 $1"');
  });

  it("cita até três regras e conta o resto, no idioma de quem salva", async () => {
    h.idioma = "es";
    h.regras = ["A", "B", "C", "D", "E"].map((n) => regra(n, "nascimento"));

    const r = await updatePipelineConfig(FUNIL, { fields: [NASCIMENTO_CONTATO] });

    expect(r).toEqual({
      ok: false,
      error:
        'Las reglas "A", "B", "C" y 2 más usan en el disparador por fecha un campo que marcaste como Contacto, y el disparador solo lee campos del negocio: dejarían de dispararse. Cambia el campo de las reglas o desactívalas antes.',
    });
    expect(h.gravou).toBeNull();
  });

  it("aceita quando a regra está desligada, é de outra org ou de outro funil", async () => {
    h.regras = [
      regra("Desligada", "nascimento", { is_active: false }),
      regra("Outra org", "nascimento", { organization_id: "99999999-9999-4999-8999-999999999999" }),
      regra("Outro funil", "nascimento", {
        trigger_config: { pipeline_id: OUTRO_FUNIL, campo: "nascimento", dias: 3 },
      }),
    ];

    expect(await updatePipelineConfig(FUNIL, { fields: [NASCIMENTO_CONTATO] })).toEqual({ ok: true });
    expect(h.gravou).not.toBeNull();
  });

  it("aceita marcar como Contato um campo que nenhuma regra lê", async () => {
    h.regras = [regra("Entrega", "entrega")];

    expect(await updatePipelineConfig(FUNIL, { fields: [NASCIMENTO_CONTATO] })).toEqual({ ok: true });
    expect(h.gravou).not.toBeNull();
  });

  it("aceita salvar com o campo que segue do Negócio, mesmo com regra ativa na chave", async () => {
    // O caso mais comum: a regra de aniversário funciona e alguém só muda o
    // vocabulário. Recusar aqui travaria a tela de Funis de toda org com regra.
    h.regras = [regra("Parabéns", "nascimento")];

    expect(await updatePipelineConfig(FUNIL, { fields: [NASCIMENTO_NEGOCIO] })).toEqual({ ok: true });
    expect(h.gravou).not.toBeNull();
  });

  it("aceita trocar de Contato para Negócio, mesmo com regra ativa na chave", async () => {
    h.settings = { fields: [NASCIMENTO_CONTATO] };
    h.regras = [regra("Parabéns", "nascimento")];

    expect(await updatePipelineConfig(FUNIL, { fields: [NASCIMENTO_NEGOCIO] })).toEqual({ ok: true });
    expect(h.gravou).not.toBeNull();
  });

  it("campo que JÁ era do Contato não é recusado de novo ao salvar outra coisa", async () => {
    h.settings = { fields: [NASCIMENTO_CONTATO] };
    h.regras = [regra("Antiga", "nascimento")];

    expect(await updatePipelineConfig(FUNIL, { fields: [NASCIMENTO_CONTATO] })).toEqual({ ok: true });
  });
});
