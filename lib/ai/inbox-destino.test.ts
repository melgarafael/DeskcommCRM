import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { KIND_LABEL } from "./agent-inbox-copy";
import { POLITICAS_DE_AVISO, REFERENCIAS_DE_AVISO, resolverDestinosDosAvisos } from "./inbox-destino";
import { DICIONARIO } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn() } }));
const ORG = "00000000-0000-4000-8000-000000000001";
const ID = "00000000-0000-4000-8000-000000000002";
const missing = "00000000-0000-4000-8000-000000000003";
const PIPELINE = "00000000-0000-4000-8000-000000000004";
const aviso = (kind = "handoff", ref_kind: string | null = "conversation", ref_id: string | null = ID) => ({ kind, ref_kind, ref_id });
function leitor(rows = [ID], falha = false, pipelineVisible = true) {
  const queries: { table: string; org?: string; ids?: string[]; archived?: boolean }[] = [];
  const client = { from(table: string) {
    const q = { table } as typeof queries[number]; queries.push(q);
    const chain = {
      select: () => chain,
      eq: (key: string, value: string) => { expect(key).toBe("organization_id"); q.org = value; return chain; },
      in: (key: string, ids: string[]) => { expect(key).toBe("id"); q.ids = ids; return chain; },
      is: (key: string, value: null) => { expect([key, value]).toEqual(["archived_at", null]); q.archived = true; return chain; },
      then: (resolve: (data: unknown) => unknown) => Promise.resolve({ data: table === "crm_pipelines" ? pipelineVisible ? [{ id: PIPELINE }] : [] : rows.map(id => ({ id, pipeline_id: PIPELINE })), error: falha ? { message: "SECRET payload" } : null }).then(resolve),
    };
    return chain;
  } } as unknown as SupabaseClient;
  return { client, queries };
}
describe("destinos da Central", () => {
  it("aviso Meet abre só compromisso visível ao agente e mantém os vetos do resolvedor", async () => {
    for (const [role, rows, failure, state] of [
      ["agent", [ID], false, "disponivel"],
      ["viewer", [ID], false, "sem_permissao"],
      ["agent", [], false, "indisponivel"],
      ["agent", [ID], true, "indisponivel"],
    ] as const) {
      const l = leitor([...rows], failure);
      const [item] = await resolverDestinosDosAvisos(l.client, ORG, role, [aviso("other", "appointment")]);
      expect(item?.destination.estado).toBe(state);
      if (state === "disponivel") expect(item?.destination).toMatchObject({ href: `/app/agenda?compromisso=${ID}`, rotulo: "Abrir compromisso" });
      else expect(item?.destination).not.toHaveProperty("href");
      expect(l.queries).toEqual(role === "viewer" ? [] : [{ table: "calendar_appointments", org: ORG, ids: [ID] }]);
    }
    const l = leitor();
    const [invalidPair] = await resolverDestinosDosAvisos(l.client, ORG, "admin", [aviso("handoff", "appointment")]);
    expect(invalidPair?.destination).not.toHaveProperty("href");
    expect(l.queries).toHaveLength(0);
  });
  it("toda categoria possui política", () => expect(Object.keys(POLITICAS_DE_AVISO).sort()).toEqual(Object.keys(KIND_LABEL).sort()));
  it.each([
    ["handoff", "conversation", `/app/inbox/${ID}`], ["job_dead", "conversation", `/app/inbox/${ID}`],
    ["handoff", "contact", `/app/contacts/${ID}`], ["other", "lead", `/app/pipelines/${PIPELINE}?lead=${ID}`],
    ["followup_dead", "followup_enrollment", `/app/ai/followups/enrollments/${ID}`],
    ["qr_rescan", "channel_session", "/app/connections"], ["conhecimento_nao_indexado", "ai_knowledge_source", "/app/ai/knowledge/sources"],
  ])("%s/%s abre somente contexto real", async (kind, ref, href) => {
    const l = leitor(); const [item] = await resolverDestinosDosAvisos(l.client, ORG, "admin", [aviso(kind, ref)]);
    expect(item?.destination).toMatchObject({ estado: "disponivel", href });
    expect(l.queries[0]?.org).toBe(ORG);
    if (ref === "channel_session") expect(l.queries[0]?.archived).toBe(true);
  });
  it("consulta por tipo e deduplica IDs, não N+1", async () => {
    const l = leitor();
    await resolverDestinosDosAvisos(l.client, ORG, "agent", [...Array.from({ length: 150 }, () => aviso()), aviso("handoff", "contact")]);
    expect(l.queries).toEqual([{ table: "conversations", org: ORG, ids: [ID] }, { table: "contacts", org: ORG, ids: [ID] }]);
  });
  it("negócio sem funil visível não abre coleção genérica ou outro tenant", async () => {
    const l = leitor([ID], false, false);
    const [item] = await resolverDestinosDosAvisos(l.client, ORG, "agent", [aviso("other", "lead")]);
    expect(item?.destination.estado).toBe("indisponivel");
    expect(l.queries).toEqual([{ table: "crm_leads", org: ORG, ids: [ID] }, { table: "crm_pipelines", org: ORG, ids: [PIPELINE] }]);
  });
  it.each(["agent", "manager"] as const)("%s não recebe conexão admin", async role => {
    const l = leitor(); const [item] = await resolverDestinosDosAvisos(l.client, ORG, role, [aviso("qr_rescan", "channel_session")]);
    expect(item?.destination.estado).toBe("sem_permissao"); expect(l.queries).toHaveLength(0);
  });
  it("manager recebe uso/acervo e agent apenas orientação", async () => {
    for (const role of ["agent", "manager"] as const) {
      const items = await resolverDestinosDosAvisos(leitor().client, ORG, role, [aviso("budget_warning", "ai_budget", ORG), aviso("conhecimento_nao_indexado", "ai_knowledge_source")]);
      expect(items.map(i => i.destination.estado)).toEqual(Array(2).fill(role === "agent" ? "sem_permissao" : "disponivel"));
    }
  });
  it.each([null, "not-a-uuid", missing])("ref %s não vira URL", async id => {
    const [item] = await resolverDestinosDosAvisos(leitor().client, ORG, "agent", [aviso("handoff", "conversation", id)]);
    expect(item?.destination.estado).toBe("indisponivel"); expect(item?.destination).not.toHaveProperty("href");
  });
  it("zero linhas RLS, removido e erro são indistinguíveis; diagnóstico sanitizado", async () => {
    const denied = await resolverDestinosDosAvisos(leitor([]).client, ORG, "agent", [aviso()]);
    const error = await resolverDestinosDosAvisos(leitor([ID], true).client, ORG, "agent", [aviso()]);
    expect(error).toEqual(denied);
    expect(logger.warn).toHaveBeenLastCalledWith(expect.any(String), { referencia: "conversation", quantidade: 1 });
  });
  it.each(["budget_exceeded", "risk_backlog_seeded", "reactivation_expired"])("%s aceita apenas org ativa", async kind => {
    const ref = kind === "budget_exceeded" ? "ai_budget" : "organization";
    const items = await resolverDestinosDosAvisos(leitor().client, ORG, "admin", [aviso(kind, ref, ORG), aviso(kind, ref, ID)]);
    expect(items[0]?.destination.estado).toBe("disponivel"); expect(items[1]?.destination.estado).toBe("indisponivel");
  });
  it("kind/ref desconhecidos, pares inválidos e URLs arbitrárias falham fechados", async () => {
    const l = leitor(); const items = await resolverDestinosDosAvisos(l.client, ORG, "admin", [aviso("novo"), aviso("handoff", "https://evil.test"), aviso("handoff", "channel_session"), aviso("__proto__"), aviso("other", "__proto__")]);
    expect(items.every(i => !("href" in i.destination))).toBe(true); expect(l.queries).toHaveLength(0);
  });
  it("referências técnicas não inventam tela; modelos sem ID abrem canal Parceiro", async () => {
    const items = await resolverDestinosDosAvisos(leitor().client, ORG, "admin", [aviso("job_dead", "job_queue"), aviso("channel_template_review", null, null), aviso("contact_proposal_expired", "organization", ORG)]);
    expect(items[0]?.destination.estado).toBe("sem_destino");
    expect(items[1]?.destination).toMatchObject({ href: "/app/connections?aba=parceiro&sub=templates", orientacao: expect.stringContaining("não identifica") });
    expect(items[2]?.destination.estado).toBe("sem_destino");
  });
  it("envio preso representa uma conversa, não todas", async () => {
    const [item] = await resolverDestinosDosAvisos(leitor().client, ORG, "agent", [aviso("message_send_stuck")]);
    expect(item?.destination).toMatchObject({ rotulo: "Abrir uma conversa afetada" });
  });
  it("textos dinâmicos do catálogo e fallbacks têm espanhol", async () => {
    const textos = new Set<string>(Object.values(REFERENCIAS_DE_AVISO).map(a => a.rotulo));
    for (const [kind, p] of Object.entries(POLITICAS_DE_AVISO)) {
      textos.add(p.orientacao);
      for (const papel of ["agent", "admin"] as const) {
        const items = await resolverDestinosDosAvisos(leitor().client, ORG, papel, [
          aviso(kind, null, null), aviso(kind, "conversation", missing),
          ...p.refs.map(ref => aviso(kind, ref, ref === "organization" || ref === "ai_budget" ? ORG : ID)),
        ]);
        for (const { destination } of items) {
          if (destination.orientacao) textos.add(destination.orientacao);
          if (destination.estado === "disponivel") textos.add(destination.rotulo);
        }
      }
    }
    const [unknown] = await resolverDestinosDosAvisos(leitor().client, ORG, "agent", [aviso("new-kind")]);
    if (unknown?.destination.orientacao) textos.add(unknown.destination.orientacao);
    for (const texto of textos) expect(DICIONARIO[texto]?.es, texto).toBeTruthy();
  });
});

it('reparo do agente legado tem destino tipado somente para admin e entidade visível',async()=>{
 const item=aviso('other','ai_agent');
 const [admin]=await resolverDestinosDosAvisos(leitor().client,ORG,'admin',[item]);
 expect(admin?.destination).toMatchObject({estado:'disponivel',href:`/app/ai/agents/${ID}`});
 for(const role of ['viewer','agent','manager'] as const){
  const [denied]=await resolverDestinosDosAvisos(leitor().client,ORG,role,[item]);
  expect(denied?.destination.estado).toBe('sem_permissao');
 }
 const [foreign]=await resolverDestinosDosAvisos(leitor([]).client,ORG,'admin',[item]);
 expect(foreign?.destination.estado).toBe('indisponivel');
});
