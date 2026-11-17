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
 *
 * ─── #2888 — a junção mudou de lado, e o dublê mudou com ela ───────────────
 *
 * Este arquivo NÃO mede mais a releitura do aplicativo: desde a 0682 não há
 * releitura nenhuma aqui. Quem junta é `fn_lead_adicionar_etiquetas` /
 * `fn_contato_adicionar_etiquetas`, DENTRO do `UPDATE` (`tags || array(select
 * unnest(p) except select unnest(tags))`), e o que decide escrita e evento é o
 * que ela devolve no `RETURNING`. O dublê abaixo emula esse contrato — inclusive
 * o dedupe e o "nada entrou, nada grava" — para que o que continua sendo medido
 * AQUI seja o que a ação faz com a resposta, não como ela monta a lista.
 *
 * A corrida entre dois EVENTOS DIFERENTES (que o app não pode resolver, e é o
 * motivo da mudança) é medida com transações de verdade em
 * `tests/invariants/add-tag-concorrente-nao-apaga.test.ts`, contra o Postgres.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/atendimento/origem-automacao", () => ({
  originFromAutomationEvent: vi.fn(async () => null),
}));

import { getAction } from "@/lib/automation/actions";
import "@/lib/automation/actions/add-tag";
import type { ActionCtx } from "@/lib/automation/types";

/** Banco de mentira: guarda as etiquetas por linha, e serve as DUAS funções de
 *  junção da 0682 com a mesma semântica do SQL (`except` = nada duplica). */
function banco(inicial: Record<string, string[]>, falhaDeLeitura = false) {
  const linhas: Record<string, string[]> = { ...inicial };
  const gravacoes: Array<{ tabela: string; tags: string[] }> = [];
  const eventos: Array<Record<string, unknown>> = [];
  const juncoes: Array<{ rpc: string; args: Record<string, unknown> }> = [];

  const admin = {
    async rpc(nome: string, args: Record<string, unknown>) {
      if (nome === "emit_event") {
        eventos.push(args);
        return { data: null, error: null };
      }
      if (nome !== "fn_lead_adicionar_etiquetas" && nome !== "fn_contato_adicionar_etiquetas") {
        throw new Error(`banco de mentira: rpc desconhecida ${nome}`);
      }
      juncoes.push({ rpc: nome, args });
      if (falhaDeLeitura) return { data: null, error: { message: "indisponível" } };

      const id = String(nome === "fn_lead_adicionar_etiquetas" ? args.p_lead : args.p_contato);
      const pedidas = ((args.p_etiquetas as string[] | undefined) ?? []).map(String);
      // Sem linha (ou linha de outra organização): nulo, como a função devolve.
      if (!(id in linhas)) return { data: null, error: null };

      const antes = linhas[id]!;
      const adicionadas = pedidas.filter((t) => !antes.includes(t));
      const tabela = nome === "fn_lead_adicionar_etiquetas" ? "crm_leads" : "contacts";
      if (adicionadas.length) {
        linhas[id] = [...antes, ...adicionadas];
        gravacoes.push({ tabela, tags: linhas[id]! });
      }
      return { data: { tags: linhas[id]!, adicionadas }, error: null };
    },
  } as unknown as ActionCtx["admin"];
  return { admin, linhas, gravacoes, eventos, juncoes };
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

  it("⭐ a ação não monta a lista: quem junta é a função do banco, sobre a linha VIGENTE", async () => {
    // A foto diz uma lista, o banco diz outra — a do banco é a que vale, e é o
    // que o `UPDATE` da 0682 garante sem o app ter de reler nada.
    const { admin, juncoes } = banco({ "lead-1": ["do-banco"] });
    await addTag().execute(
      ctx(admin, { lead: { id: "lead-1", tags: ["da-foto-velha"] } }, "r"),
      { tags: ["nova"] },
    );

    expect(juncoes).toHaveLength(1);
    expect(juncoes[0]!.rpc).toBe("fn_lead_adicionar_etiquetas");
    expect(juncoes[0]!.args).toMatchObject({
      p_org: "org-1",
      p_lead: "lead-1",
      p_etiquetas: ["nova"],
    });
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
    const { admin, linhas, juncoes } = banco({ "contato-1": ["cliente"] });
    await addTag().execute(ctx(admin, { contact: { id: "contato-1", tags: [] } }, "r"), {
      tags: ["origem-web"],
    });

    expect(juncoes[0]!.rpc).toBe("fn_contato_adicionar_etiquetas");
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

describe("add_tag soma etiquetas Google Ads pela mesma escrita nativa", () => {
  const origem = {
    source: "google_ads",
    source_metadata: { ad_platform: "google_ads", utm_campaign: "Consultas", google_campaign_id: "123" },
  };

  it.each([
    ["card", "fn_lead_adicionar_etiquetas", "lead-1", "lead.tag_added"],
    ["contato", "fn_contato_adicionar_etiquetas", "c-1", "contact.tag_added"],
  ])("destino %s preserva org, literais, idempotência e evento anti-laço", async (destino, rpc, id, evento) => {
    const { admin, linhas, juncoes, eventos } = banco({ "lead-1": ["anterior"], "c-1": ["anterior"] });
    const contexto = ctx(admin, { lead: { id: "lead-1", contact_id: "c-1", ...origem } }, "r-google");
    const config = { tags: ["literal {{nao_interpola}}"], google_ads_fields: ["campaign"], destino };

    await addTag().execute(contexto, config);
    await addTag().execute(contexto, config);

    expect(juncoes[0]).toMatchObject({ rpc, args: {
      p_org: "org-1",
      p_etiquetas: ["literal {{nao_interpola}}", "Google Ads · campanha: Consultas [123]"],
    } });
    expect(linhas[id!]).toEqual(["anterior", "literal {{nao_interpola}}", "Google Ads · campanha: Consultas [123]"]);
    expect(eventos).toHaveLength(1);
    expect(eventos[0]).toMatchObject({
      p_event_type: evento, p_organization_id: "org-1", p_entity_id: id,
      p_payload: { added_tags: ["literal {{nao_interpola}}", "Google Ads · campanha: Consultas [123]"] },
      p_metadata: { caused_by_rule: "r-google" },
    });
  });

  it("só cria as automáticas por opção explícita e ignora campos sem valor", async () => {
    const { admin, juncoes } = banco({ "lead-1": [] });
    const contexto = ctx(admin, { lead: { id: "lead-1", ...origem } }, "r");
    expect(await addTag().execute(contexto, { tags: [] })).toMatchObject({ status: "skipped", detail: { reason: "no_tags" } });
    expect(await addTag().execute(contexto, { tags: [], google_ads_fields: ["account"] })).toMatchObject({ status: "skipped", detail: { reason: "no_tags" } });
    expect(juncoes).toHaveLength(0);
    await addTag().execute(contexto, { tags: [], google_ads_fields: ["campaign"] });
    expect(juncoes[0]?.args.p_etiquetas).toEqual(["Google Ads · campanha: Consultas [123]"]);
  });

  it("sem origem Google continua aplicando as mesmas literais", async () => {
    const { admin, juncoes } = banco({ "lead-1": [] });
    await addTag().execute(ctx(admin, { lead: { id: "lead-1", source: "meta_ads", source_metadata: { utm_campaign: "Consultas" } } }, "r"), {
      tags: ["literal"], google_ads_fields: ["campaign"],
    });
    expect(juncoes[0]?.args.p_etiquetas).toEqual(["literal"]);
  });

  it("linha de outra organização continua sem escrita nem evento", async () => {
    const { admin, juncoes, eventos } = banco({});
    const resultado = await addTag().execute(ctx(admin, { lead: { id: "lead-1", contact_id: "outro-tenant", ...origem } }, "r"), {
      tags: [], google_ads_fields: ["campaign"], destino: "contato",
    });
    expect(resultado).toMatchObject({ status: "skipped", detail: { reason: "no_contact" } });
    expect(juncoes[0]?.args).toMatchObject({ p_org: "org-1", p_contato: "outro-tenant" });
    expect(eventos).toHaveLength(0);
  });
});
