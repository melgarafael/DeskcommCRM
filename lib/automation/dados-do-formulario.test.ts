import { describe, it, expect } from "vitest";

import { dadosDoFormularioDoContexto } from "@/lib/automation/dados-do-formulario";
import type { ActionCtx } from "@/lib/automation/types";

const ORG = "00000000-0000-4000-8000-000000000001";
const PIPELINE = "00000000-0000-4000-8000-0000000000aa";

/**
 * Dublê do cliente admin: cada tabela devolve a linha combinada e o encadeamento
 * (`eq`, `order`, `limit`) é indiferente — o que se mede é o que a função FAZ com
 * o que o banco devolve, e que `organization_id` foi filtrado.
 */
function adminFalso(
  tabelas: Record<string, unknown>,
  filtros: Array<[string, string, unknown]> = [],
) {
  return {
    from(tabela: string) {
      const cadeia: Record<string, unknown> = {};
      const volta = () => cadeia;
      cadeia.select = volta;
      cadeia.order = volta;
      cadeia.limit = volta;
      cadeia.eq = (coluna: string, valor: unknown) => {
        filtros.push([tabela, coluna, valor]);
        return cadeia;
      };
      cadeia.maybeSingle = async () => ({ data: tabelas[tabela] ?? null, error: null });
      return cadeia;
    },
  } as unknown as ActionCtx["admin"];
}

function ctx(admin: ActionCtx["admin"], lead: Record<string, unknown> | undefined): ActionCtx {
  return {
    admin,
    organizationId: ORG,
    ruleId: "r1",
    context: { lead, contact: { name: "Maria Teste", phone_number: "+5511988887777" } },
  } as unknown as ActionCtx;
}

const funil = {
  settings: {
    fields: [
      { key: "servico", label: "Serviço que precisa", type: "select" },
      { key: "message", label: "Mensagem", type: "textarea" },
    ],
  },
};

describe("dadosDoFormularioDoContexto — rótulo do funil no lugar da chave crua", () => {
  it("campo cadastrado entra pelo rótulo; o não cadastrado segue pela chave", async () => {
    const admin = adminFalso({
      webhook_lead_captures: {
        fields: { servico: "projeto_customizado", message: "quero orçamento", qtd: "3" },
        utm: {},
        source_name: "Site",
      },
      crm_pipelines: funil,
    });
    const r = await dadosDoFormularioDoContexto(ctx(admin, { id: "l1", pipeline_id: PIPELINE }));
    expect(r.dados).toMatchObject({
      Nome: "Maria Teste",
      "Serviço que precisa": "projeto_customizado",
      Mensagem: "quero orçamento",
      qtd: "3",
    });
    expect(r.dados).not.toHaveProperty("servico");
    expect(r.origemDaAbordagem).toBe("formulario");
  });

  it("o plano B (sem captação) também usa o rótulo", async () => {
    const admin = adminFalso({ crm_pipelines: funil });
    const r = await dadosDoFormularioDoContexto(
      ctx(admin, { id: "l1", pipeline_id: PIPELINE, custom_fields: { servico: "consultoria" } }),
    );
    expect(r.dados["Serviço que precisa"]).toBe("consultoria");
    expect(r.origemDaAbordagem).toBe("automacao");
  });

  it("sem definição cadastrada, o modelo recebe a chave crua (o que recebia antes)", async () => {
    const admin = adminFalso({
      webhook_lead_captures: { fields: { servico: "x" }, utm: {}, source_name: "Site" },
      crm_pipelines: { settings: {} },
    });
    const r = await dadosDoFormularioDoContexto(ctx(admin, { id: "l1", pipeline_id: PIPELINE }));
    expect(r.dados.servico).toBe("x");
  });

  it("lead sem funil no contexto não consulta o banco de funis nem quebra", async () => {
    const admin = adminFalso({
      webhook_lead_captures: { fields: { servico: "x" }, utm: {}, source_name: "Site" },
    });
    const r = await dadosDoFormularioDoContexto(ctx(admin, { id: "l1" }));
    expect(r.dados.servico).toBe("x");
  });

  it("a leitura do funil filtra a organização (service role não confia em id solto)", async () => {
    const filtros: Array<[string, string, unknown]> = [];
    const admin = adminFalso({ crm_pipelines: funil }, filtros);
    await dadosDoFormularioDoContexto(ctx(admin, { id: "l1", pipeline_id: PIPELINE }));
    expect(filtros).toContainEqual(["crm_pipelines", "organization_id", ORG]);
    expect(filtros).toContainEqual(["crm_pipelines", "id", PIPELINE]);
  });

  it("rótulo que colide com dado do contato não o sobrescreve", async () => {
    const admin = adminFalso({
      webhook_lead_captures: { fields: { nome_do_cliente: "Outro" }, utm: {}, source_name: "Site" },
      crm_pipelines: {
        settings: { fields: [{ key: "nome_do_cliente", label: "Nome", type: "text" }] },
      },
    });
    const r = await dadosDoFormularioDoContexto(ctx(admin, { id: "l1", pipeline_id: PIPELINE }));
    expect(r.dados.Nome).toBe("Maria Teste");
  });
});
