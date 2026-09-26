/**
 * `crm_list_appointments` COMO PORTA DE INTEGRAÇÃO (issue #1744).
 *
 * ## A fronteira
 *
 * `agenda-lista-por-periodo-e-cursor.test.ts` mede a REGRA em
 * `lib/agenda/consulta.ts`. Aqui se mede o que a FERRAMENTA acrescenta por cima
 * dela: o repasse dos parâmetros novos, o formato do que um calendário externo
 * lê (contato, atendente, tipo, local, vínculos) e a face de cada recusa.
 *
 * A coleta fica mockada de propósito — as duas suítes medindo a mesma coisa
 * seria a terceira lista da qual o repo avisa.
 *
 * ⚠️ O NOME DO ATENDENTE NÃO É MOCKADO: ele passa pelo helper de verdade
 * (`lib/mcp/tools/_users.ts`), que é a regra de exposição de responsável. Se
 * alguém trocar o helper por uma montagem de nome à mão, este arquivo cai — e
 * se a exposição alargar além do `full_name`, a asserção de não-vazamento cai.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";

import type * as AgendaConsulta from "@/lib/agenda/consulta";
import type { McpContext } from "@/lib/mcp/types";

vi.mock("@/lib/agenda/consulta", async (original) => {
  const real = await original<typeof AgendaConsulta>();
  return { ...real, listaAgendamentos: vi.fn() };
});

const { listaAgendamentos } = await import("@/lib/agenda/consulta");
const { crmListAppointments } = await import("@/lib/mcp/tools/agendamento");

const DONO = "11111111-1111-4111-8111-111111111111";
const CONTATO = "22222222-2222-4222-8222-222222222222";

/**
 * O client do agente É o do admin no MCP — e é nele que o helper de nomes lê
 * `user_metadata.full_name`. Aqui se reproduz só essa superfície: o resto da
 * lista está mockado.
 */
const ctx: McpContext = {
  organizationId: "org-1",
  role: "agent",
  actor: { type: "ai_agent", id: "ag-1", role: "ai_operator" },
  apiTokenId: "tok-1",
  requestId: "req-1",
  supabase: {
    auth: {
      admin: {
        getUserById: async () => ({
          data: {
            user: {
              user_metadata: {
                full_name: "Ana Souza",
                // LGPD: isto NUNCA pode aparecer na resposta.
                email: "ana@clinica.com.br",
                phone: "+5511999990000",
              },
            },
          },
          error: null,
        }),
      },
    },
  } as unknown as SupabaseClient,
};

const ITEM = {
  id: "9a1f0000-0000-4000-8000-0000000000aa",
  titulo: "Consulta inicial",
  iniciaEm: "2026-09-12T15:00:00.000Z",
  terminaEm: "2026-09-12T15:30:00.000Z",
  fuso: "America/Sao_Paulo",
  situacao: "confirmed",
  donoId: DONO,
  contatoId: CONTATO,
  contatoNome: "Maria Silva",
  tipo: { slug: "consulta", nome: "Consulta" },
  local: { tipo: "in_person", descricao: "Sala 2" },
  leadIds: ["33333333-3333-4333-8333-333333333333"],
};

beforeEach(() => vi.clearAllMocks());

describe("os parâmetros novos chegam à regra", () => {
  it("⭐ `de`, `ate` e `depois_de` são repassados, com o vínculo pedido", async () => {
    vi.mocked(listaAgendamentos).mockResolvedValue({ ok: true, agendamentos: [] });

    await crmListAppointments.handler(
      {
        de: "2026-09-01T00:00:00-03:00",
        ate: "2026-09-08T00:00:00-03:00",
        depois_de: "eyJpbmljaW8iOiIyMDI2",
        limite: 30,
      },
      ctx,
    );

    const params = vi.mocked(listaAgendamentos).mock.calls[0]![2];
    expect(params.de).toBe("2026-09-01T00:00:00-03:00");
    expect(params.ate).toBe("2026-09-08T00:00:00-03:00");
    expect(params.depoisDe).toBe("eyJpbmljaW8iOiIyMDI2");
    expect(params.limite).toBe(30);
    // Um calendário lê o vínculo com o negócio; a grade da tela não — por isso
    // é opção na regra e OBRIGATÓRIA aqui.
    expect(params.comLeadIds).toBe(true);
  });

  it("o schema aceita instante ISO com fuso e recusa data sem hora", () => {
    const shape = crmListAppointments.inputSchema;
    expect(() => shape.de.parse("2026-09-01T00:00:00-03:00")).not.toThrow();
    expect(() => shape.de.parse("2026-09-01")).toThrow();
    expect(() => shape.ate.parse("2026-09-08T00:00:00Z")).not.toThrow();
  });

  it("a descrição da tool anuncia o período, o teto e o cursor", () => {
    const d = crmListAppointments.description;
    expect(d).toContain("de+ate");
    expect(d).toContain("62 dias");
    // Sem isto o integrante guarda 50 itens e acha que acabou a agenda.
    expect(d).toContain("depois_de");
    expect(d).toContain("proximo");
  });

  it("⭐ o campo `dia` diz que o dia é do fuso da ORGANIZAÇÃO", () => {
    // A issue aceitava dois caminhos — trocar o corte OU avisar na descrição.
    // Aqui se fazem os DOIS: o corte mudou (medido na outra suíte) e a
    // descrição não deixa ninguém de surpresa.
    const dia = crmListAppointments.inputSchema.dia as unknown as { description?: string };
    expect(dia.description ?? "").toMatch(/FUSO DA ORGANIZAÇÃO/i);
    expect(dia.description ?? "").toContain("AAAA-MM-DD");
  });
});

describe("a resposta tem o que um calendário mostra (issue #1744)", () => {
  it("⭐ contato, atendente, tipo, local e vínculos no mesmo item", async () => {
    vi.mocked(listaAgendamentos).mockResolvedValue({ ok: true, agendamentos: [ITEM] });

    const r = (await crmListAppointments.handler({ de: "2026-09-01T00:00:00Z", ate: "2026-09-08T00:00:00Z" }, ctx)) as {
      compromissos: Array<Record<string, unknown>>;
      proximo: string | null;
    };

    expect(r.compromissos).toHaveLength(1);
    expect(r.compromissos[0]).toMatchObject({
      id: ITEM.id,
      titulo: ITEM.titulo,
      inicio: ITEM.iniciaEm,
      fim: ITEM.terminaEm,
      fuso: ITEM.fuso,
      situacao: ITEM.situacao,
      contato: { id: CONTATO, nome: "Maria Silva" },
      atendente: { id: DONO, nome: "Ana Souza" },
      tipo: { slug: "consulta", nome: "Consulta" },
      local: { tipo: "in_person", descricao: "Sala 2" },
      lead_ids: ["33333333-3333-4333-8333-333333333333"],
    });
    expect(r.proximo).toBeNull();
  });

  it("⭐ as chaves antigas contato_id/atendente_id seguem na resposta (compatibilidade)", async () => {
    vi.mocked(listaAgendamentos).mockResolvedValue({ ok: true, agendamentos: [ITEM] });

    const r = (await crmListAppointments.handler({ contact_id: CONTATO }, ctx)) as {
      compromissos: Array<Record<string, unknown>>;
    };

    // `toMatchObject` acima não reprova chave a menos: esta asserção é a que vê
    // um integrador que lia a forma anterior à #1744 passar a receber `undefined`.
    expect(r.compromissos[0]?.contato_id).toBe(CONTATO);
    expect(r.compromissos[0]?.atendente_id).toBe(DONO);
  });

  it("⭐ o nome do atendente vem do helper — e SÓ o nome sai", async () => {
    vi.mocked(listaAgendamentos).mockResolvedValue({ ok: true, agendamentos: [ITEM] });

    const r = await crmListAppointments.handler({ contact_id: CONTATO }, ctx);
    const json = JSON.stringify(r);

    // É a mesma régua de exposição de responsável: `full_name`, e nada além.
    expect(json).toContain("Ana Souza");
    expect(json).not.toContain("ana@clinica.com.br");
    expect(json).not.toContain("+5511999990000");
    // E o contato NÃO é montado aqui: o rótulo vem da regra da biblioteca.
    expect(json).toContain("Maria Silva");
  });

  it("compromisso sem dono não consulta ninguém nem promete nome", async () => {
    vi.mocked(listaAgendamentos).mockResolvedValue({
      ok: true,
      agendamentos: [{ ...ITEM, donoId: null }],
    });

    const r = (await crmListAppointments.handler({ contact_id: CONTATO }, ctx)) as {
      compromissos: Array<{ atendente: { id: string | null; nome: string | null } }>;
    };
    expect(r.compromissos[0]!.atendente).toEqual({ id: null, nome: null });
  });

  it("⭐ `proximo` é repassado adiante — é o integrante que decide continuar", async () => {
    vi.mocked(listaAgendamentos).mockResolvedValue({
      ok: true,
      agendamentos: [ITEM],
      proximo: "eyJpbmljaW8iOiIyMDI2In0",
    });

    const r = (await crmListAppointments.handler({ de: "2026-09-01T00:00:00Z", ate: "2026-09-08T00:00:00Z" }, ctx)) as {
      proximo: string | null;
    };
    expect(r.proximo).toBe("eyJpbmljaW8iOiIyMDI2In0");
  });
});

describe("as recusas saem como RESPOSTA, na face do cliente (DECISÃO 20)", () => {
  it.each([
    ["janela_invalida", "Divida em partes de até"],
    ["cursor_invalido", "Comece de novo do início"],
    ["sem_alvo", "Pergunte de qual cliente"],
  ])("%s vira { compromissos: [], motivo, mensagem } sem exceção", async (codigo, trecho) => {
    vi.mocked(listaAgendamentos).mockResolvedValue({
      ok: false,
      codigo,
      motivoParaOperador: `operador: ${codigo}`,
      motivoParaCliente: trecho,
    } as never);

    const r = (await crmListAppointments.handler({ de: "2026-09-01T00:00:00Z", ate: "2026-10-10T00:00:00Z" }, ctx)) as {
      compromissos: unknown[];
      motivo: string;
      mensagem: string;
    };

    expect(r.compromissos).toEqual([]);
    expect(r.motivo).toBe(codigo);
    expect(r.mensagem).toBe(trecho);
    // A face do OPERADOR (que nomeia campo) não vaza para o modelo/cliente.
    expect(r.motivo).not.toContain("operador:");
  });

  it("CONTROLE: o sucesso não traz motivo nem mensagem", async () => {
    // Sem este par, um handler que devolvesse `motivo` SEMPRE passaria nos
    // cinco casos acima.
    vi.mocked(listaAgendamentos).mockResolvedValue({ ok: true, agendamentos: [] });
    const r = (await crmListAppointments.handler({ contact_id: CONTATO }, ctx)) as {
      motivo?: string;
      mensagem?: string;
      compromissos: unknown[];
    };
    expect(r.motivo).toBeUndefined();
    expect(r.mensagem).toBeUndefined();
    expect(r.compromissos).toEqual([]);
  });
});
