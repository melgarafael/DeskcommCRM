/**
 * QUANDO A EMPRESA ENTRA NO FUNIL — `funnel_entry: "on_start" | "on_send"`.
 *
 * ## O defeito que isto conserta
 *
 * Ao iniciar uma campanha, o sistema criava contato, negócio e conversa para a fila
 * INTEIRA. Medido numa campanha real: 47 empresas esperando, todas na etapa de entrada
 * do funil há dois dias sem uma mensagem enviada — o funil dizia "Abordado" de quem
 * ninguém tinha abordado, e desmarcar uma empresa já enfileirada exigiria apagar
 * negócio e contato (e o produto nem tem função de apagar negócio).
 *
 * No modo `on_send`, cada empresa nasce no CRM só na vez de ser abordada.
 *
 * ## O que este arquivo guarda
 *
 * 1. o PADRÃO continua `on_start`: configuração gravada antes da chave existir se
 *    comporta como sempre, e é isso que permite atualizar sem editar nada;
 * 2. no `on_send`, iniciar NÃO chama nenhum cadastro; no `on_start`, chama;
 * 3. as duas triagens (escolha do operador, telefone, contato que já existe) valem
 *    nos DOIS modos — a contagem da fila tem de ser honesta desde o primeiro minuto;
 * 4. a preparação é idempotente (execução interrompida não duplica contato nem negócio);
 * 5. o erro de UMA empresa é dela (4xx marca só ela); falha de infraestrutura sobe.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ contato: vi.fn(), negocio: vi.fn(), fronteira: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/app/api/v1/contacts/_handler", () => ({ createContactHandler: m.contato }));
vi.mock("@/app/api/v1/leads/_handler", () => ({ createLeadHandler: m.negocio }));
vi.mock("@/lib/atendimento/origem", () => ({
  beginServiceAtOrigin: m.fronteira,
  assertServiceBoundarySupabase: vi.fn(),
}));

import { campaignConfigSchema } from "@/lib/prospecting/schema";
import {
  criarPegadaDoCandidato,
  enfileirarCandidatos,
  prepararCandidatoNoEnvio,
  triarCandidato,
  type Candidate,
} from "@/lib/prospecting/store";

const ORG = "0b110000-0000-4000-8000-000000000001";
const CAMPANHA = "0b110000-1111-4000-8000-000000000001";
const CONTATO = "0b110000-2222-4000-8000-000000000001";
const NEGOCIO = "0b110000-3333-4000-8000-000000000001";
const CONVERSA = "0b110000-4444-4000-8000-000000000001";
const uuid = (n: number) => `0b110000-5555-4000-8000-${String(n).padStart(12, "0")}`;

const baseConfig = {
  agent_id: uuid(1),
  channel_session_id: uuid(2),
  pipeline_id: uuid(3),
  stage_id: uuid(4),
  qualified_stage_id: uuid(5),
  instruction: "Vender consultoria para clínicas.",
  qualification: "Confirmou a necessidade e a decisão.",
  daily_limit: 10,
  interval_minutes: 15,
  legal_basis_ref: "LIA-teste",
};
const configOnSend = campaignConfigSchema.parse({ ...baseConfig, funnel_entry: "on_send" });
const configOnStart = campaignConfigSchema.parse({ ...baseConfig, funnel_entry: "on_start" });
const campanha = { id: CAMPANHA, name: "Clínicas de Sorocaba", organization_id: ORG };

const candidato = (n: number, extra: Record<string, unknown> = {}) =>
  ({
    id: uuid(100 + n),
    organization_id: ORG,
    campaign_id: CAMPANHA,
    data: { name: `Clínica ${n}`, key: `place-${n}`, maps_url: null, socials: [] },
    status: "new",
    selected: true,
    phone: `+55119999900${String(n).padStart(2, "0")}`,
    contact_id: null,
    lead_id: null,
    conversation_id: null,
    service_boundary: null,
    message_id: uuid(200 + n),
    ...extra,
  }) as unknown as Candidate;

type Dublê = {
  contatosConhecidos?: { id: string }[];
  contatoDaCampanha?: { id: string }[];
  negocioExistente?: { id: string } | null;
};
function bancoFalso(d: Dublê = {}) {
  const chamadas: { sql: string; params: unknown[] }[] = [];
  const db = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      chamadas.push({ sql, params });
      if (sql.includes("phone_number=any")) return { rows: d.contatosConhecidos ?? [] };
      if (sql.includes("source='prospecting' and source_metadata"))
        return { rows: d.contatoDaCampanha ?? [] };
      if (sql.includes("from crm_leads where"))
        return { rows: d.negocioExistente ? [d.negocioExistente] : [] };
      if (sql.includes("returning *"))
        return {
          rows: [
            {
              ...candidato(1),
              status: "queued",
              contact_id: CONTATO,
              lead_id: NEGOCIO,
              conversation_id: CONVERSA,
            },
          ],
        };
      return { rows: [] };
    }),
  };
  return { db: db as never, chamadas };
}
const gravou = (chamadas: { sql: string }[], trecho: string) =>
  chamadas.some((c) => c.sql.includes(trecho));

beforeEach(() => {
  vi.clearAllMocks();
  m.contato.mockResolvedValue({ contact: { id: CONTATO } });
  m.negocio.mockResolvedValue({ id: NEGOCIO });
  m.fronteira.mockResolvedValue({ conversation_id: CONVERSA });
});

describe("a escolha mora na configuração da campanha", () => {
  const sem = { ...baseConfig };

  it("configuração gravada ANTES da chave existir continua `on_start` — atualizar não muda ninguém", () => {
    expect(campaignConfigSchema.parse(sem).funnel_entry).toBe("on_start");
  });

  it("aceita os dois modos e recusa qualquer outro valor", () => {
    expect(campaignConfigSchema.safeParse({ ...sem, funnel_entry: "on_send" }).success).toBe(true);
    expect(campaignConfigSchema.safeParse({ ...sem, funnel_entry: "on_start" }).success).toBe(true);
    expect(campaignConfigSchema.safeParse({ ...sem, funnel_entry: "depois" }).success).toBe(false);
  });
});

describe("enfileirarCandidatos: o que acontece ao iniciar", () => {
  const fila = () => [
    candidato(1),
    candidato(2, { selected: false }),
    candidato(3, { phone: null }),
    candidato(4),
  ];

  it("`on_send`: NENHUM cadastro é chamado; as empresas elegíveis só entram na fila", async () => {
    const { db, chamadas } = bancoFalso();
    await enfileirarCandidatos(db, {} as never, ORG, campanha, configOnSend, fila());
    expect(m.contato).not.toHaveBeenCalled();
    expect(m.negocio).not.toHaveBeenCalled();
    expect(m.fronteira).not.toHaveBeenCalled();
    const enfileiradas = chamadas.filter((c) => c.sql.includes("set status='queued'"));
    expect(enfileiradas.map((c) => c.params[1])).toEqual([uuid(101), uuid(104)]);
    expect(
      gravou(chamadas, "set contact_id"),
      "no `on_send` a empresa não ganha contato ao entrar na fila",
    ).toBe(false);
  });

  it("`on_start`: contato, negócio e conversa nascem para cada empresa elegível (comportamento de sempre)", async () => {
    const { db } = bancoFalso();
    await enfileirarCandidatos(db, {} as never, ORG, campanha, configOnStart, fila());
    expect(m.contato).toHaveBeenCalledTimes(2);
    expect(m.negocio).toHaveBeenCalledTimes(2);
    expect(m.fronteira).toHaveBeenCalledTimes(2);
  });

  it.each([
    { modo: "on_send", config: configOnSend },
    { modo: "on_start", config: configOnStart },
  ])(
    "`$modo`: a desmarcada e a sem telefone viram 'Não abordado' com o motivo",
    async ({ config }) => {
      const { db, chamadas } = bancoFalso();
      await enfileirarCandidatos(db, {} as never, ORG, campanha, config, fila());
      const puladas = chamadas
        .filter((c) => c.sql.includes("set status='skipped'"))
        .map((c) => [c.params[1], c.params[2]]);
      expect(puladas).toEqual([
        [uuid(102), "Não selecionada pelo operador."],
        [uuid(103), "Sem telefone brasileiro válido."],
      ]);
    },
  );

  it.each([
    { modo: "on_send", config: configOnSend },
    { modo: "on_start", config: configOnStart },
  ])("`$modo`: telefone que já é contato do CRM nunca é atropelado", async ({ config }) => {
    const { db, chamadas } = bancoFalso({ contatosConhecidos: [{ id: "alheio" }] });
    await enfileirarCandidatos(db, {} as never, ORG, campanha, config, [candidato(1)]);
    expect(m.contato).not.toHaveBeenCalled();
    expect(chamadas.find((c) => c.sql.includes("set status='skipped'"))?.params[2]).toBe(
      "Contato já existe no CRM; atendimento preservado.",
    );
  });
});

describe("triarCandidato", () => {
  it("telefone desconhecido: segue, sem contato da campanha", async () => {
    const { db } = bancoFalso();
    expect(await triarCandidato(db, ORG, CAMPANHA, candidato(1))).toEqual({
      contatoDaCampanha: null,
    });
  });

  it("contato que esta MESMA campanha já criou numa execução interrompida é reaproveitado", async () => {
    const { db } = bancoFalso({
      contatosConhecidos: [{ id: CONTATO }],
      contatoDaCampanha: [{ id: CONTATO }],
    });
    expect(await triarCandidato(db, ORG, CAMPANHA, candidato(1))).toEqual({
      contatoDaCampanha: CONTATO,
    });
  });

  it("contato de outra origem: pula, e a consulta do contato da campanha leva o id da campanha e o lugar", async () => {
    const { db, chamadas } = bancoFalso({ contatosConhecidos: [{ id: "alheio" }] });
    expect(await triarCandidato(db, ORG, CAMPANHA, candidato(1))).toEqual({
      motivo: "Contato já existe no CRM; atendimento preservado.",
    });
    const dono = chamadas.find((c) => c.sql.includes("source='prospecting'"));
    expect(dono?.params).toEqual([ORG, "alheio", CAMPANHA, "place-1"]);
  });

  it("sem telefone: pula, e nem consulta o CRM", async () => {
    const { db, chamadas } = bancoFalso();
    expect(await triarCandidato(db, ORG, CAMPANHA, candidato(1, { phone: null }))).toEqual({
      motivo: "Sem telefone brasileiro válido.",
    });
    expect(chamadas).toHaveLength(0);
  });
});

describe("criarPegadaDoCandidato", () => {
  it("cria contato (com a base legal), negócio na etapa de entrada e conversa, e devolve a linha já na fila", async () => {
    const { db } = bancoFalso();
    const linha = await criarPegadaDoCandidato(
      db,
      {} as never,
      ORG,
      campanha,
      configOnSend,
      candidato(1),
      null,
    );
    expect(m.contato.mock.calls[0]?.[2]).toMatchObject({
      source: "prospecting",
      source_metadata: { campaign_id: CAMPANHA, place_id: "place-1" },
      consent: { legitimate_interest: { ref: "LIA-teste" } },
    });
    expect(m.negocio.mock.calls[0]?.[2]).toMatchObject({
      stage_id: configOnSend.stage_id,
      contact_id: CONTATO,
      external_id: uuid(101),
    });
    expect(m.fronteira).toHaveBeenCalledWith({}, ORG, CONTATO, configOnSend.channel_session_id);
    expect(linha).toMatchObject({ status: "queued", conversation_id: CONVERSA });
  });

  it("idempotente: contato da campanha e negócio que já existem não são criados de novo", async () => {
    const { db } = bancoFalso({ negocioExistente: { id: NEGOCIO } });
    await criarPegadaDoCandidato(
      db,
      {} as never,
      ORG,
      campanha,
      configOnSend,
      candidato(1),
      CONTATO,
    );
    expect(m.contato).not.toHaveBeenCalled();
    expect(m.negocio).not.toHaveBeenCalled();
    expect(m.fronteira).toHaveBeenCalledTimes(1);
  });
});

describe("prepararCandidatoNoEnvio: a preparação na vez da empresa", () => {
  it("sucesso: devolve a linha pronta para o envio", async () => {
    const { db } = bancoFalso();
    const linha = await prepararCandidatoNoEnvio(
      db,
      {} as never,
      campanha,
      configOnSend,
      candidato(1),
    );
    expect(linha).toMatchObject({ conversation_id: CONVERSA, contact_id: CONTATO });
  });

  it("telefone que virou contato no meio do caminho: sai da fila como 'Não abordado', só se ainda estava na fila", async () => {
    const { db, chamadas } = bancoFalso({ contatosConhecidos: [{ id: "alheio" }] });
    expect(
      await prepararCandidatoNoEnvio(db, {} as never, campanha, configOnSend, candidato(1)),
    ).toBeNull();
    expect(m.contato).not.toHaveBeenCalled();
    const pulou = chamadas.find((c) => c.sql.includes("set status='skipped'"));
    expect(pulou?.sql).toContain("and status='queued'");
    expect(pulou?.params[2]).toBe("Contato já existe no CRM; atendimento preservado.");
  });

  it("recusa 4xx do cadastro é DELA: marca só essa empresa como falhada e segue", async () => {
    m.contato.mockRejectedValue(Object.assign(new Error("Telefone inválido."), { status: 422 }));
    const { db, chamadas } = bancoFalso();
    expect(
      await prepararCandidatoNoEnvio(db, {} as never, campanha, configOnSend, candidato(1)),
    ).toBeNull();
    const falhou = chamadas.find((c) => c.sql.includes("set status='failed'"));
    expect(falhou?.sql).toContain("and status='queued'");
    expect(String(falhou?.params[2])).toContain("Telefone inválido.");
  });

  it("falha de infraestrutura NÃO marca a empresa: sobe, e quem pausa é a campanha", async () => {
    m.contato.mockRejectedValue(Object.assign(new Error("banco fora do ar"), { status: 503 }));
    const { db, chamadas } = bancoFalso();
    await expect(
      prepararCandidatoNoEnvio(db, {} as never, campanha, configOnSend, candidato(1)),
    ).rejects.toThrow("banco fora do ar");
    expect(gravou(chamadas, "set status='failed'")).toBe(false);
  });

  it("erro sem status também sobe: sem classificação, falha fechado", async () => {
    m.contato.mockRejectedValue(new Error("explodiu"));
    const { db, chamadas } = bancoFalso();
    await expect(
      prepararCandidatoNoEnvio(db, {} as never, campanha, configOnSend, candidato(1)),
    ).rejects.toThrow("explodiu");
    expect(gravou(chamadas, "set status='failed'")).toBe(false);
  });
});

describe("prepararCandidatoNoEnvio: os casos de borda que o revisor cego apontou", () => {
  it("empresa PARCIALMENTE preparada (contato já ligado, negócio ainda não): reaproveita o contato e cria só o negócio", async () => {
    // Execução anterior caiu depois de criar o contato: o candidato guarda `contact_id`, e o
    // telefone já aparece como contato conhecido do CRM — que é o dele, não de um terceiro.
    const { db } = bancoFalso({ contatosConhecidos: [{ id: CONTATO }] });
    const linha = await prepararCandidatoNoEnvio(
      db,
      {} as never,
      campanha,
      configOnSend,
      candidato(1, { contact_id: CONTATO }),
    );
    expect(m.contato, "o contato já existe: não se cria outro").not.toHaveBeenCalled();
    expect(m.negocio).toHaveBeenCalledTimes(1);
    expect(linha).toMatchObject({ status: "queued", conversation_id: CONVERSA });
  });

  it("recusa 4xx do cadastro do NEGÓCIO depois de o contato existir: a empresa falha, mas o contato fica LIGADO ao candidato (rastreável pela LGPD)", async () => {
    m.negocio.mockRejectedValue(Object.assign(new Error("Etapa inválida."), { status: 422 }));
    const { db, chamadas } = bancoFalso();
    expect(
      await prepararCandidatoNoEnvio(db, {} as never, campanha, configOnSend, candidato(1)),
    ).toBeNull();
    const ligou = chamadas.findIndex((c) => c.sql.includes("set contact_id=$3 where"));
    const falhou = chamadas.findIndex((c) => c.sql.includes("set status='failed'"));
    expect(ligou, "o vínculo é gravado assim que o contato nasce").toBeGreaterThanOrEqual(0);
    expect(falhou).toBeGreaterThan(ligou);
    expect(m.fronteira, "sem negócio não se abre conversa").not.toHaveBeenCalled();
  });

  it("nome de UMA letra (o schema do negócio exige duas): falha só essa empresa, e NADA é criado antes", async () => {
    const { db, chamadas } = bancoFalso();
    const curto = candidato(1);
    curto.data = { ...curto.data, name: "A" };
    expect(
      await prepararCandidatoNoEnvio(db, {} as never, campanha, configOnSend, curto),
    ).toBeNull();
    expect(
      m.contato,
      "a validação vem ANTES de qualquer escrita: sem contato órfão",
    ).not.toHaveBeenCalled();
    expect(m.negocio).not.toHaveBeenCalled();
    const falhou = chamadas.find((c) => c.sql.includes("set status='failed'"));
    expect(falhou?.sql).toContain("and status='queued'");
    expect(String(falhou?.params[2])).toContain("nome curto demais");
  });
});
