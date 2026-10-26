import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { createAdminClient } from "@/lib/supabase/admin";
import { configuracaoPadrao } from "./exemplos";
import { processarCadencias } from "./worker";
import type { Passo } from "./tipos";

const mocks = vi.hoisted(() => ({ modulo: vi.fn(), empresa: vi.fn(), enviar: vi.fn(), atividade: vi.fn() }));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: mocks.modulo }));
vi.mock("./modulo", () => ({ cadenciasLigadas: mocks.empresa }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/tarefas/atividade", () => ({ registraAtividadeDaTarefa: mocks.atividade }));
vi.mock("@/lib/email/roteador", () => ({ sendEmail: mocks.enviar }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: async () => ({ allowed: true, count: 1 }) }));
vi.mock("@/lib/env", () => ({ env: { NEXT_PUBLIC_APP_URL: "https://cadencias.test", CADENCIA_LIMITE_EMAILS_POR_DIA: 60 } }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
const agora = new Date("2026-10-26T15:00:00Z");
const email: Passo = { id: "email-1", tipo: "email", assunto: "Olá {{primeiro_nome}}", corpo: "Uma mensagem sintética", mesmaConversa: false };
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** Fake só da borda Supabase; exercita o motor, inclusive a ordem dos efeitos. */
function bancada(opcoes: { consentimento?: boolean; pendente?: string; falhaAoAvancar?: boolean; passos?: Passo[] } = {}) {
  const inscricao: Record<string, unknown> = { id: id(1), organization_id: id(2), cadence_id: id(3), lead_id: id(4), contact_id: id(5), passo_atual_id: null, ultimo_email_em: null, ultimo_email_passo_id: null, aberturas: 0, aberturas_ultimo_email: 0, emails_enviados: 0, tentativas: 0, inscrito_por: null, rastreio_consentido: opcoes.consentimento ?? false, envio_pendente_passo_id: opcoes.pendente ?? null, status: "ativa", proximo_em: agora.toISOString(), processando_ate: null };
  const eventos: Record<string, unknown>[] = [];
  const tarefas: Record<string, unknown>[] = [];
  let leituras = 0;
  function from(tabela: string) {
    leituras++;
    let patch: Record<string, unknown> | null = null;
    let insercao: Record<string, unknown> | null = null;
    const filtros: [string, unknown][] = [];
    const executar = () => {
      if (tabela === "email_cadences") return { data: { id: id(3), status: "ativa", passos: opcoes.passos ?? [email], configuracao: configuracaoPadrao() }, error: null };
      if (tabela === "contacts") return { data: { email: "pessoa@synthetic.test", name: "Pessoa Sintética", display_name: "Pessoa Sintética", is_anonymized: false }, error: null };
      if (tabela === "crm_leads") return { data: { owner_user_id: null, status: "open" }, error: null };
      if (tabela === "crm_tasks") { if (insercao) tarefas.push(insercao); return { data: { ...insercao, id: id(6) }, error: null }; }
      if (tabela === "email_cadence_events") { if (insercao) eventos.push(insercao); return { data: null, error: null }; }
      if (tabela === "email_cadence_enrollments") {
        if (!patch) return { data: inscricao.status === "ativa" ? [{ ...inscricao }] : [], error: null };
        if (filtros.some(([campo, valor]) => inscricao[campo] !== valor)) return { data: null, error: null };
        if (opcoes.falhaAoAvancar && "emails_enviados" in patch) return { data: null, error: { code: "synthetic_failure" } };
        Object.assign(inscricao, patch);
        return { data: { id: inscricao.id }, error: null };
      }
      throw new Error(`Tabela inesperada: ${tabela}`);
    };
    const q = {
      select: () => q, limit: () => q, lte: () => q, or: () => q,
      eq: (campo: string, valor: unknown) => { filtros.push([campo, valor]); return q; },
      is: (campo: string, valor: unknown) => { filtros.push([campo, valor]); return q; },
      update: (v: Record<string, unknown>) => { patch = v; return q; },
      insert: (v: Record<string, unknown>) => { insercao = v; return q; },
      maybeSingle: async () => executar(), single: async () => executar(),
      then: (resolver: (value: ReturnType<typeof executar>) => unknown) => Promise.resolve(executar()).then(resolver),
    };
    return q;
  }
  let sequencia = 7;
  const rpc = async (nome: string, args: Record<string, unknown>) => {
    leituras++;
    if (nome === "fn_cadencias_reivindicar") {
      const instante = String(args.p_agora);
      if (inscricao.status !== "ativa" || String(inscricao.proximo_em) > instante) return { data: [], error: null };
      const token = id(sequencia++);
      inscricao.processamento_id = token;
      return { data: [{ ...inscricao }], error: null };
    }
    if (nome === "fn_cadencia_reservar_envio") {
      if (inscricao.status !== "ativa" || inscricao.processamento_id !== args.p_processamento_id || inscricao.envio_pendente_passo_id !== null) return { data: null, error: { message: "cadencia_claim_lost" } };
      inscricao.envio_pendente_passo_id = args.p_passo_id;
      return { data: true, error: null };
    }
    if (nome === "fn_cadencia_criar_tarefa") {
      const anterior = eventos.find((e) => e.tipo === "tarefa_criada" && e.passo_id === args.p_passo_id);
      if (anterior) return { data: { criada_agora: false, tarefa: tarefas[0] }, error: null };
      const tarefa = { id: id(6), title: args.p_titulo, due_date: args.p_due_date, priority: "medium", lead_id: inscricao.lead_id, contact_id: inscricao.contact_id, created_by: null };
      tarefas.push(tarefa); eventos.push({ tipo: "tarefa_criada", passo_id: args.p_passo_id });
      return { data: { criada_agora: true, tarefa }, error: null };
    }
    throw new Error(`RPC inesperada: ${nome}`);
  };
  return { admin: { from, rpc } as unknown as ReturnType<typeof createAdminClient>, inscricao, eventos, tarefas, leituras: () => leituras };
}
afterEach(() => vi.unstubAllEnvs());
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("INTERNAL_SECRET", "segredo-sintetico-para-provar-o-motor");
  mocks.modulo.mockResolvedValue(true); mocks.empresa.mockResolvedValue(true); mocks.enviar.mockResolvedValue({ ok: true, via: "smtp" });
});
describe("efeitos do worker de cadências", () => {
  it("módulo ausente não consulta tabelas nem envia", async () => {
    mocks.modulo.mockResolvedValue(false); const b = bancada();
    await processarCadencias(b.admin, agora, "request-sintetico");
    expect(b.leituras()).toBe(0); expect(mocks.enviar).not.toHaveBeenCalled();
  });
  it("empresa desligada e horário fora da janela não enviam", async () => {
    const b = bancada(); mocks.empresa.mockResolvedValue(false);
    await processarCadencias(b.admin, agora, "request-sintetico");
    expect(mocks.enviar).not.toHaveBeenCalled();
    mocks.empresa.mockResolvedValue(true);
    await processarCadencias(b.admin, new Date("2026-10-26T22:00:00Z"), "request-sintetico");
    expect(mocks.enviar).not.toHaveBeenCalled(); expect(b.inscricao.status).toBe("ativa");
  });
  it("sem autorização manda descadastro, sem pixel, e contabiliza o último envio", async () => {
    const b = bancada(); const r = await processarCadencias(b.admin, agora, "request-sintetico");
    expect(r.emailsEnviados).toBe(1); expect(mocks.enviar).toHaveBeenCalledTimes(1);
    const args = mocks.enviar.mock.calls[0]![0];
    expect(args.html).toContain("cadencia-descadastro/"); expect(args.html).not.toContain("<img");
    expect(b.inscricao.emails_enviados).toBe(1); expect(b.inscricao.status).toBe("concluida"); expect(b.inscricao.envio_pendente_passo_id).toBeNull();
  });
  it("com autorização inclui pixel e dois tokens distintos", async () => {
    const b = bancada({ consentimento: true }); await processarCadencias(b.admin, agora, "request-sintetico");
    const html: string = mocks.enviar.mock.calls[0]![0].html;
    const pixel = html.match(/cadencia-pixel\/([^\"]+)/)?.[1]; const saida = html.match(/cadencia-descadastro\/([^\"]+)/)?.[1];
    expect(pixel).toBeTruthy(); expect(saida).toBeTruthy(); expect(pixel).not.toBe(saida);
  });
  it("tarefa automática assina atividade como sistema mesmo sem usuário inscritor", async () => {
    const b = bancada({ passos: [{ id: "tarefa-1", tipo: "tarefa", titulo: "Ligar para {{primeiro_nome}}", prazoDias: 1 }, email] });
    await processarCadencias(b.admin, agora, "request-sintetico");
    expect(b.tarefas).toHaveLength(1); expect(b.tarefas[0]!.created_by).toBeNull(); expect(b.tarefas[0]!.title).toBe("Ligar para Pessoa");
    expect(mocks.atividade).toHaveBeenCalledWith(b.admin, expect.objectContaining({ actor: { type: "webhook_source", id: "cadencias" } }));
    expect(b.inscricao.passo_atual_id).toBe("email-1");
  });
  it("resultado local incerto após envio confirmado não reenvia no próximo tick", async () => {
    const b = bancada({ falhaAoAvancar: true });
    await processarCadencias(b.admin, agora, "request-sintetico");
    expect(b.inscricao.envio_pendente_passo_id).toBe("email-1");
    await processarCadencias(b.admin, new Date(agora.getTime() + 60 * 60 * 1000), "request-sintetico");
    expect(mocks.enviar).toHaveBeenCalledTimes(1); expect(b.inscricao.status).toBe("parada"); expect(b.inscricao.ultimo_erro).toBe("cadencia_delivery_unconfirmed");
  });
});
