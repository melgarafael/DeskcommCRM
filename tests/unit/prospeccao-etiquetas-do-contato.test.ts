/**
 * A CAMPANHA DE PROSPECÇÃO GRAVA AS ETIQUETAS DO CONTATO ANTES DE ABORDAR — spec 27, fatia 1.
 *
 * O defeito: a skill que entra pela etiqueta do contato não encontrava etiqueta nenhuma na
 * primeira resposta, porque a campanha nunca a gravava. Agora a configuração pode trazer
 * `contact_tags`, e `criarPegadaDoCandidato` põe essas etiquetas no contato pela MESMA junção
 * atômica da ação `add_tag` antes de a empresa seguir para o envio.
 *
 * O que este arquivo prova, sem banco:
 *   - a configuração: ausente = a mesma saída de hoje; presente = normalizada e até 5;
 *   - a junção roda com o contato NOVO e com o REAPROVEITADO, e não roda sem a lista;
 *   - o evento `contact.tag_added` só sai quando alguma etiqueta é nova;
 *   - falha da junção não derruba a abordagem (aviso no log, empresa segue na fila);
 *   - `adjust_tags` só mexe em campanha pausada e audita de quanto para quanto;
 *   - a ação nova entra no schema da rota com o mesmo fechamento de `adjust_pace`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  contato: vi.fn(),
  negocio: vi.fn(),
  fronteira: vi.fn(),
  aviso: vi.fn(),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/app/api/v1/contacts/_handler", () => ({ createContactHandler: m.contato }));
vi.mock("@/app/api/v1/leads/_handler", () => ({ createLeadHandler: m.negocio }));
vi.mock("@/lib/atendimento/origem", () => ({
  beginServiceAtOrigin: m.fronteira,
  assertServiceBoundarySupabase: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({
  logger: { warn: m.aviso, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { campaignConfigSchema, prospectingInputSchema } from "@/lib/prospecting/schema";
import {
  AJUSTE_DE_ETIQUETAS_SQL,
  adjustTags,
  criarPegadaDoCandidato,
  type Candidate,
} from "@/lib/prospecting/store";

const ORG = "0c110000-0000-4000-8000-000000000001";
const CAMPANHA = "0c110000-1111-4000-8000-000000000001";
const CONTATO_NOVO = "0c110000-2222-4000-8000-000000000001";
const CONTATO_DA_CAMPANHA = "0c110000-2222-4000-8000-000000000009";
const NEGOCIO = "0c110000-3333-4000-8000-000000000001";
const CONVERSA = "0c110000-4444-4000-8000-000000000001";
const uuid = (n: number) => `0c110000-5555-4000-8000-${String(n).padStart(12, "0")}`;

const baseConfig = {
  agent_id: uuid(1),
  channel_session_id: uuid(2),
  pipeline_id: uuid(3),
  stage_id: uuid(4),
  qualified_stage_id: uuid(5),
  instruction: "Vender consultoria para clínicas.",
  qualification: "Confirmou a necessidade e a decisão.",
  legal_basis_ref: "LIA-teste",
};

const campanha = { id: CAMPANHA, name: "Clínicas de Sorocaba" };

const candidato = (extra: Record<string, unknown> = {}) =>
  ({
    id: uuid(100),
    organization_id: ORG,
    campaign_id: CAMPANHA,
    data: { name: "Clínica Sol", key: "place-1", maps_url: null, socials: [] },
    status: "new",
    selected: true,
    phone: "+5511999990001",
    contact_id: null,
    lead_id: null,
    conversation_id: null,
    service_boundary: null,
    message_id: uuid(200),
    ...extra,
  }) as unknown as Candidate;

/** Admin falso: `rpc` responde pela função chamada; o que foi pedido fica em `chamadas`. */
function adminFalso(resposta: (nome: string) => { data?: unknown; error?: { message: string } | null } = () => ({ data: null, error: null })) {
  const chamadas: { nome: string; args: Record<string, unknown> }[] = [];
  const admin = {
    rpc: vi.fn(async (nome: string, args: Record<string, unknown>) => {
      chamadas.push({ nome, args });
      return resposta(nome);
    }),
  };
  return { admin: admin as never, chamadas };
}

/** Banco falso da pegada: consultas que não importam respondem vazio; o `returning *` devolve o candidato na fila. */
function bancoFalso() {
  const chamadas: { sql: string; params: unknown[] }[] = [];
  const db = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      chamadas.push({ sql, params });
      if (sql.includes("from crm_leads where")) return { rows: [] };
      if (sql.includes("returning *"))
        return {
          rows: [
            { ...candidato(), status: "queued", contact_id: CONTATO_NOVO, lead_id: NEGOCIO, conversation_id: CONVERSA },
          ],
        };
      return { rows: [] };
    }),
  };
  return { db: db as never, chamadas };
}

const comEtiquetas = (contact_tags: string[]) =>
  campaignConfigSchema.parse({ ...baseConfig, contact_tags });
const semEtiquetas = campaignConfigSchema.parse(baseConfig);

beforeEach(() => {
  vi.clearAllMocks();
  m.contato.mockResolvedValue({ contact: { id: CONTATO_NOVO } });
  m.negocio.mockResolvedValue({ id: NEGOCIO });
  m.fronteira.mockResolvedValue({ conversation_id: CONVERSA });
});

describe("a configuração aceita as etiquetas sem mudar a campanha de quem já existe", () => {
  it("sem `contact_tags` a configuração sai sem a chave: é a mesma de antes desta spec", () => {
    expect("contact_tags" in semEtiquetas).toBe(false);
    expect(JSON.stringify(semEtiquetas)).not.toContain("contact_tags");
  });

  it("normaliza como o CRM guarda: minúscula, sem espaço, sem repetida", () => {
    expect(comEtiquetas([" Estetica ", "estetica", "VIP"]).contact_tags).toEqual(["estetica", "vip"]);
  });

  it("aceita até 5 e recusa a sexta", () => {
    expect(comEtiquetas(["a", "b", "c", "d", "e"]).contact_tags).toHaveLength(5);
    expect(
      campaignConfigSchema.safeParse({
        ...baseConfig,
        contact_tags: ["a", "b", "c", "d", "e", "f"],
      }).success,
    ).toBe(false);
  });

  it("lista vazia (ou só de espaços) vira lista vazia, sem erro", () => {
    expect(comEtiquetas([]).contact_tags).toEqual([]);
    expect(comEtiquetas(["   "]).contact_tags).toEqual([]);
  });
});

describe("criarPegadaDoCandidato põe as etiquetas no contato antes do envio", () => {
  const JUNCAO = "fn_contato_adicionar_etiquetas";

  it("contato NOVO: a junção roda no contato recém-criado com a lista da campanha", async () => {
    const { db } = bancoFalso();
    const { admin, chamadas } = adminFalso((nome) =>
      nome === JUNCAO
        ? { data: { tags: ["estetica"], adicionadas: ["estetica"] }, error: null }
        : { data: null, error: null },
    );
    await criarPegadaDoCandidato(db, admin, ORG, campanha, comEtiquetas(["estetica"]), candidato(), null);
    const juncao = chamadas.find((c) => c.nome === JUNCAO);
    expect(juncao?.args).toEqual({ p_org: ORG, p_contato: CONTATO_NOVO, p_etiquetas: ["estetica"] });
  });

  it("contato REAPROVEITADO (criado por esta campanha antes): a junção roda nele, sem criar outro", async () => {
    const { db } = bancoFalso();
    const { admin, chamadas } = adminFalso((nome) =>
      nome === JUNCAO
        ? { data: { tags: ["estetica"], adicionadas: ["estetica"] }, error: null }
        : { data: null, error: null },
    );
    await criarPegadaDoCandidato(
      db,
      admin,
      ORG,
      campanha,
      comEtiquetas(["estetica"]),
      candidato(),
      CONTATO_DA_CAMPANHA,
    );
    expect(m.contato).not.toHaveBeenCalled();
    expect(chamadas.find((c) => c.nome === JUNCAO)?.args).toMatchObject({
      p_contato: CONTATO_DA_CAMPANHA,
    });
  });

  it("sem `contact_tags` a função de junção NÃO é chamada e nenhum evento sai", async () => {
    const { db } = bancoFalso();
    const { admin, chamadas } = adminFalso();
    await criarPegadaDoCandidato(db, admin, ORG, campanha, semEtiquetas, candidato(), null);
    expect(chamadas.some((c) => c.nome === JUNCAO)).toBe(false);
    expect(chamadas.some((c) => c.nome === "emit_event")).toBe(false);
  });

  it("lista vazia também não chama a junção (a função do banco recusa lista vazia)", async () => {
    const { db } = bancoFalso();
    const { admin, chamadas } = adminFalso();
    await criarPegadaDoCandidato(db, admin, ORG, campanha, comEtiquetas([]), candidato(), null);
    expect(chamadas.some((c) => c.nome === JUNCAO)).toBe(false);
  });

  it("etiqueta NOVA no contato: anuncia `contact.tag_added` com o que entrou, como a ação add_tag", async () => {
    const { db } = bancoFalso();
    const { admin, chamadas } = adminFalso((nome) =>
      nome === JUNCAO
        ? { data: { tags: ["estetica"], adicionadas: ["estetica"] }, error: null }
        : { data: null, error: null },
    );
    await criarPegadaDoCandidato(db, admin, ORG, campanha, comEtiquetas(["estetica"]), candidato(), null);
    const evento = chamadas.find((c) => c.nome === "emit_event");
    expect(evento?.args).toMatchObject({
      p_event_type: "contact.tag_added",
      p_entity_kind: "contact",
      p_entity_id: CONTATO_NOVO,
      p_organization_id: ORG,
      p_payload: { added_tags: ["estetica"], tags: ["estetica"], service_origin: null },
    });
    // `null` é o valor certo para a campanha (sem evento raiz de automação): a chave existe e vale
    // null, não é ausente nem um objeto inventado. Ver o comentário em marcarEtiquetasDaCampanha.
    expect(evento?.args.p_payload).toHaveProperty("service_origin", null);
  });

  it("etiqueta que o contato JÁ tinha: a junção responde adicionadas vazio e não há evento", async () => {
    const { db } = bancoFalso();
    const { admin, chamadas } = adminFalso((nome) =>
      nome === JUNCAO
        ? { data: { tags: ["estetica"], adicionadas: [] }, error: null }
        : { data: null, error: null },
    );
    await criarPegadaDoCandidato(db, admin, ORG, campanha, comEtiquetas(["estetica"]), candidato(), null);
    expect(chamadas.some((c) => c.nome === "emit_event")).toBe(false);
  });

  it("falha da junção: aviso no log e a empresa segue para a fila — a abordagem não cai", async () => {
    const { db } = bancoFalso();
    const { admin } = adminFalso((nome) =>
      nome === JUNCAO ? { data: null, error: { message: "conexão caiu" } } : { data: null, error: null },
    );
    const pegada = await criarPegadaDoCandidato(
      db,
      admin,
      ORG,
      campanha,
      comEtiquetas(["estetica"]),
      candidato(),
      null,
    );
    expect(pegada.status).toBe("queued");
    expect(m.aviso).toHaveBeenCalledTimes(1);
    expect(m.aviso.mock.calls[0]?.[1]).toMatchObject({ erro: "conexão caiu", contact_id: CONTATO_NOVO });
  });
});

type Linha = { status: string; config: Record<string, unknown> | null };
function poolDeMentira(campanhaLinha: Linha | null, atualiza = true) {
  const consultas: { texto: string; params: unknown[] }[] = [];
  const cliente = {
    query: vi.fn(async (texto: string, params: unknown[] = []) => {
      consultas.push({ texto, params });
      if (texto.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }] };
      if (texto.startsWith("select status, config")) return { rows: campanhaLinha ? [campanhaLinha] : [] };
      if (texto === AJUSTE_DE_ETIQUETAS_SQL) return { rows: atualiza ? [{ id: CAMPANHA }] : [] };
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  return { pool: { connect: async () => cliente } as never, consultas };
}
const escreveu = (consultas: { texto: string }[]) =>
  consultas.some((q) => q.texto === AJUSTE_DE_ETIQUETAS_SQL);

describe("adjust_tags: só campanha pausada, só desta organização, com a régua do ritmo", () => {
  it("campanha que não existe: 404, sem escrever", async () => {
    const { pool, consultas } = poolDeMentira(null);
    await expect(adjustTags(pool, ORG, CAMPANHA, ["vip"])).rejects.toMatchObject({ status: 404 });
    expect(escreveu(consultas)).toBe(false);
  });

  it.each(["running", "draft", "completed"])("campanha %s: 409, sem escrever", async (status) => {
    const { pool, consultas } = poolDeMentira({ status, config: { contact_tags: ["x"] } });
    await expect(adjustTags(pool, ORG, CAMPANHA, ["vip"])).rejects.toMatchObject({ status: 409 });
    expect(escreveu(consultas)).toBe(false);
  });

  it("sem configuração (nunca iniciada): 409, sem escrever", async () => {
    const { pool, consultas } = poolDeMentira({ status: "paused", config: null });
    await expect(adjustTags(pool, ORG, CAMPANHA, ["vip"])).rejects.toMatchObject({ status: 409 });
    expect(escreveu(consultas)).toBe(false);
  });

  it("pausada: escreve com organização, id e a lista em JSON, e devolve de quanto para quanto", async () => {
    const { pool, consultas } = poolDeMentira({ status: "paused", config: { contact_tags: ["estetica"] } });
    const resultado = await adjustTags(pool, ORG, CAMPANHA, ["vip", "odonto"]);
    expect(resultado).toEqual({
      previous: { contact_tags: ["estetica"] },
      next: { contact_tags: ["vip", "odonto"] },
    });
    const escrita = consultas.find((q) => q.texto === AJUSTE_DE_ETIQUETAS_SQL);
    expect(escrita?.params).toEqual([ORG, CAMPANHA, JSON.stringify(["vip", "odonto"])]);
  });

  it("campanha antiga sem etiquetas: o `previous` sai null, não some", async () => {
    const { pool } = poolDeMentira({ status: "paused", config: { daily_limit: 10 } });
    const resultado = await adjustTags(pool, ORG, CAMPANHA, []);
    expect(resultado.previous).toEqual({ contact_tags: null });
  });

  it("alguém retomou entre a leitura e a escrita: o `where` recusou e o resultado é 409", async () => {
    const { pool } = poolDeMentira({ status: "paused", config: { contact_tags: [] } }, false);
    await expect(adjustTags(pool, ORG, CAMPANHA, ["vip"])).rejects.toMatchObject({ status: 409 });
  });
});

describe("o texto do update troca só a chave das etiquetas e exige pausada", () => {
  const texto = AJUSTE_DE_ETIQUETAS_SQL.replace(/\s+/g, " ");

  it("filtra pela organização e pelo id", () => {
    expect(texto).toContain("where organization_id = $1 and id = $2");
  });

  it("só altera campanha pausada com configuração", () => {
    expect(texto).toContain("status = 'paused' and config is not null");
  });

  it("faz merge com `||` e não substitui a configuração inteira", () => {
    expect(texto).toContain("set config = config || jsonb_build_object('contact_tags', $3::jsonb)");
    expect(texto).not.toMatch(/set config\s*=\s*\$/);
  });
});

describe("a rota aceita adjust_tags com o mesmo formato fechado do ritmo", () => {
  const valido = { action: "adjust_tags", id: CAMPANHA, contact_tags: ["estetica"] };

  it("aceita a lista e a normaliza", () => {
    const parsed = prospectingInputSchema.parse({ ...valido, contact_tags: [" Estetica "] });
    expect(parsed).toMatchObject({ action: "adjust_tags", contact_tags: ["estetica"] });
  });

  it("lista vazia é um ajuste válido (tira as etiquetas)", () => {
    expect(prospectingInputSchema.safeParse({ ...valido, contact_tags: [] }).success).toBe(true);
  });

  it("recusa campo a mais — conexão, agente, instrução ficam fechados", () => {
    for (const campo of ["instruction", "agent_id", "channel_session_id", "organization_id"]) {
      expect(
        prospectingInputSchema.safeParse({ ...valido, [campo]: "x" }).success,
        `o campo ${campo} não pode passar por adjust_tags`,
      ).toBe(false);
    }
  });

  it("exige a lista: valor omitido é erro, não 'apaga sem avisar'", () => {
    expect(prospectingInputSchema.safeParse({ action: "adjust_tags", id: CAMPANHA }).success).toBe(false);
  });

  it("recusa mais de 5", () => {
    expect(
      prospectingInputSchema.safeParse({ ...valido, contact_tags: ["a", "b", "c", "d", "e", "f"] })
        .success,
    ).toBe(false);
  });
});
