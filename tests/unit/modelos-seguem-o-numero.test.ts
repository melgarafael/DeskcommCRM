/**
 * MODELO APROVADO PERTENCE A UMA CONTA, NÃO A UMA LINHA DE CONEXÃO.
 *
 * ─── O defeito, medido numa instalação real ──────────────────────────────────
 *
 * O dono reconectou a MESMA linha de conexão do canal intermediado apontando
 * para OUTRA conta do provedor (outro número). A aba "Modelos do parceiro"
 * seguiu listando os modelos aprovados da conta ANTERIOR, todos "APPROVED":
 * a listagem filtra por `channel_session_id`, e esse não mudou — quem mudou foi
 * a CONTA. Nada apagava os modelos da conta velha: o sincronizar só fazia
 * `upsert`, e reconectar não os tocava. Enviar um modelo da conta errada é
 * recusa garantida da plataforma, com a tela dizendo "aprovado" ao lado.
 *
 * Este arquivo prova o caminho de CONECTAR (`savePartnerSession`). O de
 * SINCRONIZAR mora em `tests/unit/partner-templates-route.test.ts`, e a tela
 * que nomeia o número em `tests/unit/modelos-do-parceiro-nomeiam-o-numero.test.tsx`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const log = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { warn: log.warn, info: vi.fn(), error: vi.fn() } }));

import { savePartnerSession } from "@/lib/channels/connect";
import { AVISO_MODELOS_FICARAM, AVISO_MODELOS_SAIRAM } from "@/lib/channels/modelos-de-outra-conta";

interface Chamada {
  tabela: string;
  op: "delete" | "update" | "insert";
  filtros: Array<[string, string, unknown]>;
  linha?: Record<string, unknown>;
  opcoes?: unknown;
}

let chamadas: Chamada[] = [];
let erroDaLimpeza: { message: string } | null = null;
let limpezaLanca = false;
let erroDaGravacao: { message: string } | null = null;
let apagadas = 0;
let avisoJaAberto = false;
let centralLanca = false;

function adminDuble() {
  return {
    from(tabela: string) {
      const registrar = (op: Chamada["op"], extra: Partial<Chamada> = {}) => {
        const c: Chamada = { tabela, op, filtros: [], ...extra };
        chamadas.push(c);
        const resultado = () => {
          if (tabela === "meta_templates" && limpezaLanca) throw new Error("rede caiu");
          if (tabela === "agent_inbox_items" && centralLanca) throw new Error("central fora");
          if (tabela === "meta_templates") {
            return { error: erroDaLimpeza, count: erroDaLimpeza ? null : apagadas };
          }
          return { error: tabela === "channel_sessions" ? erroDaGravacao : null };
        };
        const cadeia: Record<string, unknown> = {};
        // `insert(...).select("id").single()`: a conexão nova devolve o id.
        cadeia.select = () => cadeia;
        cadeia.single = async () => ({ data: { id: "sessao-nova" }, error: null });
        for (const m of ["eq", "neq"]) {
          cadeia[m] = (coluna: string, valor: unknown) => {
            c.filtros.push([m, coluna, valor]);
            return cadeia;
          };
        }
        cadeia.then = (ok: (r: unknown) => unknown, falha: (e: unknown) => unknown) => {
          try {
            return Promise.resolve(resultado()).then(ok, falha);
          } catch (e) {
            return Promise.reject(e).then(ok, falha);
          }
        };
        return cadeia;
      };
      return {
        delete: (opcoes?: unknown) => registrar("delete", { opcoes }),
        update: (linha: Record<string, unknown>) => registrar("update", { linha }),
        insert: (linha: Record<string, unknown>) => registrar("insert", { linha }),
        // `registrarAviso`: procura o aviso aberto antes de inserir.
        select: () => {
          const leitura: Record<string, unknown> = {
            eq: () => leitura,
            limit: () => leitura,
            maybeSingle: async () => ({ data: avisoJaAberto ? { id: "aviso-1" } : null, error: null }),
          };
          return leitura;
        },
      };
    },
  } as never;
}

const BASE = {
  organizationId: "org-1",
  accountId: "conta-nova",
  credencial: { tipo: "propria" as const, apiKeyEncrypted: "\\xcifrado" },
  webhookPathToken: "tok",
  webhookSecretEncrypted: "\\xsegredo",
  phoneNumber: "+5511900000000",
  displayName: "Atendimento",
};

beforeEach(() => {
  chamadas = [];
  erroDaLimpeza = null;
  limpezaLanca = false;
  erroDaGravacao = null;
  apagadas = 0;
  avisoJaAberto = false;
  centralLanca = false;
  log.warn.mockClear();
});

const opsDe = (tabela: string) =>
  chamadas.filter((c) => c.tabela === tabela).map((c) => c.op);
const avisosInseridos = () =>
  chamadas.filter((c) => c.tabela === "agent_inbox_items" && c.op === "insert").map((c) => c.linha);

describe("conectar: os modelos seguem a conta, não a linha da conexão", () => {
  it("⭐ reapontar a conexão existente apaga, DEPOIS de gravar, só os modelos de OUTRA conta desta conexão", async () => {
    const r = await savePartnerSession(adminDuble(), { ...BASE, existingId: "sessao-1" });

    expect(r).toEqual({ error: null, id: "sessao-1" });
    expect(chamadas.slice(0, 2).map((c) => `${c.op}:${c.tabela}`)).toEqual([
      "update:channel_sessions",
      "delete:meta_templates",
    ]);
    // `neq` é a alma da guarda: apagar só por `channel_session_id` levaria junto
    // os modelos da conta NOVA numa reconexão com a mesma conta (trocar só a
    // chave, o caso comum) — e `eq` apagaria justamente os que valem.
    expect(chamadas[1]?.filtros).toEqual([
      ["eq", "organization_id", "org-1"],
      ["eq", "channel_session_id", "sessao-1"],
      ["neq", "waba_id", "conta-nova"],
    ]);
  });

  it("troca recusada (conta já ligada a outra conexão, limite do plano) não apaga nada: a conexão ficou onde estava", async () => {
    erroDaGravacao = { message: "duplicate key value" };
    const r = await savePartnerSession(adminDuble(), { ...BASE, existingId: "sessao-1" });

    expect(r).toEqual({ error: "duplicate key value", id: null });
    expect(chamadas.map((c) => `${c.op}:${c.tabela}`)).toEqual(["update:channel_sessions"]);
  });

  it("conexão nova (sem linha anterior) não apaga nada — não há modelo de outra conta para tirar", async () => {
    const r = await savePartnerSession(adminDuble(), { ...BASE, existingId: null });
    expect(r).toEqual({ error: null, id: "sessao-nova" });
    expect(chamadas.map((c) => `${c.op}:${c.tabela}`)).toEqual(["insert:channel_sessions"]);
  });

  it("vale também para a conexão pela conta da instalação (um clique)", async () => {
    await savePartnerSession(adminDuble(), {
      ...BASE,
      credencial: { tipo: "instalacao", profileId: "perfil-1" },
      existingId: "sessao-1",
    });
    expect(chamadas[1]?.filtros).toContainEqual(["neq", "waba_id", "conta-nova"]);
  });

  it("a limpeza que falha (erro devolvido ou lançado) não impede a conexão — fica no log", async () => {
    erroDaLimpeza = { message: "permission denied" };
    const devolvido = await savePartnerSession(adminDuble(), { ...BASE, existingId: "sessao-1" });
    expect(devolvido.error).toBeNull();

    erroDaLimpeza = null;
    limpezaLanca = true;
    const lancado = await savePartnerSession(adminDuble(), { ...BASE, existingId: "sessao-1" });
    expect(lancado.error).toBeNull();

    expect(chamadas.filter((c) => c.op === "update")).toHaveLength(2);
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  // Apagar o modelo zera o escolhido no aviso e no lembrete, e o plano B do
  // follow-up morre sem lançar: sem o aviso na hora da troca, a primeira notícia
  // seria uma mensagem que não saiu, às vezes sem notícia nenhuma.
  it("⭐ a limpeza que APAGOU linhas abre um aviso na Central, com a contagem, no momento da troca", async () => {
    apagadas = 3;
    await savePartnerSession(adminDuble(), { ...BASE, existingId: "sessao-1" });

    expect(chamadas.find((c) => c.op === "delete")?.opcoes).toEqual({ count: "exact" });
    const avisos = avisosInseridos();
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toMatchObject({
      organization_id: "org-1",
      kind: "channel_template_review",
      severity: "warn",
      title: AVISO_MODELOS_SAIRAM,
    });
    expect(avisos[0]?.body).toContain("3 modelos da conta anterior saíram");
    expect(avisos[0]?.body).toContain("lembrete da Agenda");
  });

  it("reconectar na mesma conta (zero linhas apagadas) não abre aviso nenhum", async () => {
    apagadas = 0;
    await savePartnerSession(adminDuble(), { ...BASE, existingId: "sessao-1" });
    expect(avisosInseridos()).toEqual([]);
  });

  it("com o aviso ainda aberto, a segunda troca não abre outro: é UM item", async () => {
    apagadas = 2;
    avisoJaAberto = true;
    await savePartnerSession(adminDuble(), { ...BASE, existingId: "sessao-1" });
    expect(avisosInseridos()).toEqual([]);
  });

  it("⭐ a limpeza que falhou também avisa na Central: não fica só no log", async () => {
    // A mensagem é a do gatilho da Agenda, medida em
    // tests/invariants/modelo-de-outra-conta-e-o-servico-da-agenda.test.ts.
    erroDaLimpeza = { message: "service_configuration_invalid" };
    const r = await savePartnerSession(adminDuble(), { ...BASE, existingId: "sessao-1" });

    expect(r.error).toBeNull();
    const avisos = avisosInseridos();
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toMatchObject({ title: AVISO_MODELOS_FICARAM, severity: "warn" });
    expect(avisos[0]?.body).toContain("serviço da Agenda");
  });

  it("a limpeza que passou fecha o aviso de falha daquela organização", async () => {
    await savePartnerSession(adminDuble(), { ...BASE, existingId: "sessao-1" });

    const fechamento = chamadas.find((c) => c.tabela === "agent_inbox_items" && c.op === "update");
    expect(fechamento?.linha).toMatchObject({ status: "resolved" });
    expect(fechamento?.filtros).toEqual([
      ["eq", "organization_id", "org-1"],
      ["eq", "kind", "channel_template_review"],
      ["eq", "title", AVISO_MODELOS_FICARAM],
      ["eq", "status", "open"],
    ]);
  });

  it("a limpeza que falhou não fecha aviso nenhum", async () => {
    erroDaLimpeza = { message: "service_configuration_invalid" };
    await savePartnerSession(adminDuble(), { ...BASE, existingId: "sessao-1" });
    expect(opsDe("agent_inbox_items")).toEqual(["insert"]);
  });

  it("Central fora do ar depois da limpeza não vira aviso de limpeza falha nem derruba a conexão", async () => {
    apagadas = 2;
    centralLanca = true;
    const r = await savePartnerSession(adminDuble(), { ...BASE, existingId: "sessao-1" });

    expect(r).toEqual({ error: null, id: "sessao-1" });
    expect(avisosInseridos().filter((a) => a?.title === AVISO_MODELOS_FICARAM)).toEqual([]);
    expect(log.warn).toHaveBeenCalled();
  });
});
