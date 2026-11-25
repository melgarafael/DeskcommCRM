/**
 * O INTERRUPTOR POR DEGRAU CHEGA AO ENVIO — no ciclo inteiro do cron (#5154).
 *
 * `montarLembrete` sozinho não prova nada: o select pode não pedir a coluna, ou
 * a conta pode não ser passada, e todos os testes de unidade continuam verdes
 * enquanto o interruptor não faz efeito nenhum em produção. Este arquivo roda a
 * ROTA com o mesmo PostgREST falso de `lembrete-carimbo-antes-do-envio.test.ts`
 * e afirma o CORPO que chega a `sendMessageHandler`.
 *
 * Três casos, os três que a revisão do plano cobrou:
 *  - um degrau desligado, sozinho na rodada → sem linha de link;
 *  - dois degraus juntos, um ligado → a mensagem leva o link;
 *  - todos desligados e o link ainda a caminho → NÃO espera o link (a espera
 *    existe para o cliente receber como entrar; quem desligou não pediu).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enviar: vi.fn(),
  corpos: [] as string[],
}));

vi.mock("@/lib/auth/cron-auth", () => ({ autorizaCron: () => true }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
vi.mock("@/app/api/v1/messages/_handler", () => ({ sendMessageHandler: mocks.enviar }));
vi.mock("@/lib/automation/start-conversation", () => ({ ensureConversation: async () => "conversa-1" }));
vi.mock("@/lib/automation/janela-do-canal", () => ({ adiarAteAJanelaAbrir: async () => null }));
vi.mock("@/lib/automation/throttle", () => ({ espacarEnvio: async () => {} }));
vi.mock("@/lib/agenda/aviso-de-remetente", () => ({ atualizarAvisoDeRemetente: async () => {} }));
vi.mock("@/lib/agenda/remetente-do-lembrete", () => ({
  resolverRemetenteDoLembrete: async () => ({ canal: { id: "canal-1" }, motivo: null }),
}));

/** A linha que a varredura devolve. Cada caso troca o que precisa. */
let compromisso: Record<string, unknown>;

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async () => ({ data: 0, error: null }),
    from: (tabela: string) => {
      const unico: Record<string, unknown> = {
        contacts: {
          id: "contato-1",
          name: "Ana",
          display_name: null,
          phone_number: "+5531999998888",
          is_blocked: false,
        },
        organizations: { timezone: "America/Sao_Paulo", locale: "pt-BR" },
      };
      const c: Record<string, unknown> = {};
      for (const m of ["select", "eq", "not", "gt", "lte", "order", "limit", "is", "or", "update"]) {
        c[m] = () => c;
      }
      c.maybeSingle = async () => ({ data: unico[tabela] ?? null, error: null });
      c.then = (r: (v: unknown) => unknown) =>
        Promise.resolve({
          data: tabela === "calendar_appointments" ? [compromisso] : null,
          error: null,
        }).then(r);
      return c;
    },
  }),
}));

import { GET } from "@/app/api/v1/cron/agenda-reminder/route";

const MEET = "https://meet.google.com/abc-defg-hij";
const pedido = () => new Request("http://localhost/api/v1/cron/agenda-reminder") as never;

function linha(over: {
  minutosParaComecar: number;
  extras: number[] | null;
  semLink: number[] | null;
  estadoDoLink?: "ready" | "pending";
  body?: string | null;
}): Record<string, unknown> {
  return {
    id: "c-1",
    organization_id: "org-1",
    contact_id: "contato-1",
    title: "Reunião comercial",
    starts_at: new Date(Date.now() + over.minutosParaComecar * 60_000).toISOString(),
    created_at: null,
    starts_at_marked_at: null,
    location_details: null,
    location_kind: "google_meet",
    service_space_id: null,
    meeting_state: over.estadoDoLink ?? "ready",
    meeting_url: (over.estadoDoLink ?? "ready") === "ready" ? MEET : null,
    reminder_sent_offsets_minutes: null,
    reminder_sent_at: null,
    authority: "local",
    external_connection_id: null,
    calendar_resources: null,
    organizations: { status: "active" },
    calendar_event_types: {
      name: "Reunião comercial",
      reminder_enabled: true,
      reminder_minutes_before: 60,
      reminder_extra_offsets_minutes: over.extras,
      reminder_template_name: null,
      reminder_body: over.body ?? null,
      reminder_bodies: null,
      reminder_sem_link_offsets_minutes: over.semLink,
      location_details: null,
    },
  };
}

beforeEach(() => {
  mocks.corpos.length = 0;
  mocks.enviar.mockReset();
  mocks.enviar.mockImplementation(async (_admin, _ator, payload: { body?: string }) => {
    mocks.corpos.push(payload.body ?? "");
    return { id: "msg-1", status: "queued" };
  });
});

describe("o cron respeita o interruptor de cada degrau (#5154)", () => {
  it("degrau desligado, sozinho na rodada: sai a mensagem, não sai a linha do link", async () => {
    compromisso = linha({ minutosParaComecar: 30, extras: [15], semLink: [60] });

    const { data } = await (await GET(pedido())).json();

    expect(data.enviados).toBe(1);
    expect(mocks.corpos).toHaveLength(1);
    expect(mocks.corpos[0]).toContain("Reunião comercial");
    expect(mocks.corpos[0]).not.toContain("Link da reunião");
    expect(mocks.corpos[0]).not.toContain(MEET);
  });

  it("dois degraus juntos, um deles ligado: a mensagem única leva o link", async () => {
    compromisso = linha({ minutosParaComecar: 10, extras: [15], semLink: [60] });

    const { data } = await (await GET(pedido())).json();

    expect(data.enviados).toBe(1);
    expect(mocks.corpos).toHaveLength(1);
    expect(mocks.corpos[0]).toContain(`Link da reunião: ${MEET}`);
    expect(mocks.corpos[0]?.match(/https:\/\//g)).toHaveLength(1);
  });

  it("texto que pede {{link}} por conta própria: a espera continua, mesmo com o interruptor desligado", async () => {
    // Desligar tira a linha AUTOMÁTICA; não tira o `{{link}}` que a pessoa
    // escreveu. Mandar antes de o link existir entrega "Entre por aqui: " e
    // nada — e mensagem no WhatsApp não volta.
    compromisso = linha({
      minutosParaComecar: 30,
      extras: null,
      semLink: [60],
      estadoDoLink: "pending",
      body: "Oi {{nome}}! Entre por aqui: {{link}}",
    });

    const { data } = await (await GET(pedido())).json();

    expect(data.enviados).toBe(0);
    expect(data.motivos.link_da_reuniao_pendente).toBe(1);
    expect(mocks.corpos).toHaveLength(0);
  });

  it("texto com {{link}} e link pendente no apuro dos 15 min: a frase de que ele chega ainda entra", async () => {
    // Aos 15 min o cron não espera mais. Se o texto pede `{{link}}`, sair sem a
    // frase deixa "Entre por aqui: " — pior que o aviso com o link a caminho.
    compromisso = linha({
      minutosParaComecar: 14,
      extras: null,
      semLink: [60],
      estadoDoLink: "pending",
      body: "Oi {{nome}}! Entre por aqui: {{link}}",
    });

    const { data } = await (await GET(pedido())).json();

    expect(data.enviados).toBe(1);
    expect(mocks.corpos[0]).toContain("Oi Ana! Entre por aqui:");
    expect(mocks.corpos[0]).toContain("O link da reunião chega por aqui");
    expect(mocks.corpos[0]).not.toContain("https://");
  });

  it("texto com {{link}} e link pronto: o texto manda, sem linha automática duplicada", async () => {
    compromisso = linha({
      minutosParaComecar: 30,
      extras: null,
      semLink: [60],
      body: "Oi {{nome}}! Entre por aqui: {{link}}",
    });

    const { data } = await (await GET(pedido())).json();

    expect(data.enviados).toBe(1);
    expect(mocks.corpos[0]).toBe(`Oi Ana! Entre por aqui: ${MEET}`);
    expect(mocks.corpos[0]).not.toContain("Link da reunião:");
  });

  it("todos os degraus desligados e o link a caminho: não segura o aviso até os 15 min", async () => {
    compromisso = linha({
      minutosParaComecar: 30,
      extras: null,
      semLink: [60],
      estadoDoLink: "pending",
    });

    const { data } = await (await GET(pedido())).json();

    expect(data.enviados).toBe(1);
    expect(mocks.corpos[0]).not.toContain("chega por aqui");
    expect(data.motivos.link_da_reuniao_pendente).toBeUndefined();
  });
});
