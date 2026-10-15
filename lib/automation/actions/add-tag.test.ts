// Adaptado do PR https://github.com/jmpo/DeskcommCRM/pull/89 (projeto sob licença MIT).
/**
 * `add_tag` junta as etiquetas com as que estão GRAVADAS, não com a foto do
 * contexto.
 *
 * O motor monta o contexto UMA vez por evento e todas as regras daquele evento
 * o recebem. Antes, cada `add_tag` gravava `foto + as suas`, e a segunda regra
 * apagava o que a primeira tinha acabado de gravar. Caso documentado no PR original:
 * um formulário pode disparar no mesmo `lead.created` a regra
 * da etiqueta do produto e a da confirmação; o negócio ficava sem a do produto.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/atendimento/origem-automacao", () => ({
  originFromAutomationEvent: vi.fn(async () => null),
}));

import { getAction } from "@/lib/automation/actions";
import "@/lib/automation/actions/add-tag";
import type { ActionCtx } from "@/lib/automation/types";

/** Banco de mentira: guarda as etiquetas por linha e registra o que foi gravado. */
function banco(inicial: Record<string, string[]>, falhaDeLeitura = false) {
  const linhas: Record<string, string[]> = { ...inicial };
  const gravacoes: Array<{ tabela: string; tags: string[] }> = [];
  const eventos: Array<Record<string, unknown>> = [];
  const admin = {
    from(tabela: string) {
      let id = "";
      const leitura = {
        eq(coluna: string, valor: string) {
          if (coluna === "id") id = valor;
          return leitura;
        },
        async maybeSingle() {
          return { data: id in linhas ? { id, tags: linhas[id] } : null, error: falhaDeLeitura ? { message: "indisponível" } : null };
        },
      };
      return {
        select: () => leitura,
        update(payload: { tags: string[] }) {
          const escrita = {
            eq(coluna: string, valor: string) {
              if (coluna === "id") id = valor;
              return escrita;
            },
            then(resolve: (v: unknown) => void) {
              linhas[id] = payload.tags;
              gravacoes.push({ tabela, tags: payload.tags });
              resolve({ error: null });
            },
          };
          return escrita;
        },
      };
    },
    async rpc(_nome: string, args: Record<string, unknown>) {
      eventos.push(args);
      return { error: null };
    },
  } as unknown as ActionCtx["admin"];
  return { admin, linhas, gravacoes, eventos };
}

function ctx(
  admin: ActionCtx["admin"],
  context: Record<string, unknown>,
  ruleId: string,
): ActionCtx {
  return {
    admin,
    organizationId: "org-1",
    ruleId,
    ruleName: ruleId,
    event: { id: "ev-1" } as ActionCtx["event"],
    requestId: "req-1",
    context,
  } as ActionCtx;
}

const addTag = () => getAction("add_tag")!;

describe("add_tag junta com as etiquetas gravadas", () => {
  it("⭐ duas regras do MESMO evento: a segunda não apaga a etiqueta da primeira", async () => {
    const { admin, linhas } = banco({ "lead-1": [] });
    // A mesma foto para as duas regras, como o motor faz.
    const foto = { lead: { id: "lead-1", contact_id: "c-1", tags: [] as string[] } };

    await addTag().execute(ctx(admin, structuredClone(foto), "etiqueta-produto"), {
      tags: ["produto-a"],
    });
    await addTag().execute(ctx(admin, structuredClone(foto), "confirmacao"), {
      tags: ["origem-web", "formulario"],
    });

    expect(linhas["lead-1"]).toEqual(["produto-a", "origem-web", "formulario"]);
  });

  it("o evento anuncia só as etiquetas que de fato entraram", async () => {
    const { admin, eventos } = banco({ "lead-1": ["origem-web"] });
    await addTag().execute(ctx(admin, { lead: { id: "lead-1", tags: [] } }, "r"), {
      tags: ["origem-web", "formulario"],
    });

    expect(eventos[0]?.p_payload).toMatchObject({
      added_tags: ["formulario"],
      tags: ["origem-web", "formulario"],
    });
  });

  it("já tem todas: não grava nem anuncia nada", async () => {
    const { admin, gravacoes, eventos } = banco({ "lead-1": ["origem-web", "formulario"] });
    const r = await addTag().execute(ctx(admin, { lead: { id: "lead-1", tags: [] } }, "r"), {
      tags: ["origem-web"],
    });

    expect(r).toMatchObject({ status: "success", detail: { added: [] } });
    expect(gravacoes).toHaveLength(0);
    expect(eventos).toHaveLength(0);
  });

  it("sem negócio no contexto, etiqueta o CONTATO pela mesma regra", async () => {
    const { admin, linhas } = banco({ "contato-1": ["cliente"] });
    await addTag().execute(ctx(admin, { contact: { id: "contato-1", tags: [] } }, "r"), {
      tags: ["origem-web"],
    });

    expect(linhas["contato-1"]).toEqual(["cliente", "origem-web"]);
  });
  it("leitura indisponível não permite gravar a foto antiga", async () => {
    const {admin,gravacoes,eventos} = banco({"lead-1":["atual"]},true);
    const r = await addTag().execute(ctx(admin,{lead:{id:"lead-1",tags:[]}},"r"),{tags:["nova"]});
    expect(r.status).toBe("failed");expect(gravacoes).toHaveLength(0);expect(eventos).toHaveLength(0);
  });
  it("linha ausente não gera escrita nem evento de alteração inexistente", async () => {
    const {admin,gravacoes,eventos} = banco({});
    const r = await addTag().execute(ctx(admin,{lead:{id:"lead-1",tags:[]}},"r"),{tags:["nova"]});
    expect(r.status).toBe("skipped");expect(gravacoes).toHaveLength(0);expect(eventos).toHaveLength(0);
  });

  it("a foto do contexto passa a carregar o que foi gravado", async () => {
    const { admin } = banco({ "lead-1": ["atual"] });
    const context = { lead: { id: "lead-1", tags: [] as string[] } };
    await addTag().execute(ctx(admin, context, "r"), { tags: ["nova"] });

    expect(context.lead.tags).toEqual(["atual", "nova"]);
  });
});
