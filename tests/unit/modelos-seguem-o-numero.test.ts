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

interface Chamada {
  tabela: string;
  op: "delete" | "update" | "insert";
  filtros: Array<[string, string, unknown]>;
}

let chamadas: Chamada[] = [];
let erroDaLimpeza: { message: string } | null = null;
let limpezaLanca = false;

function adminDuble() {
  return {
    from(tabela: string) {
      const registrar = (op: Chamada["op"]) => {
        const c: Chamada = { tabela, op, filtros: [] };
        chamadas.push(c);
        const resultado = () => {
          if (tabela === "meta_templates" && limpezaLanca) throw new Error("rede caiu");
          return { error: tabela === "meta_templates" ? erroDaLimpeza : null };
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
        delete: () => registrar("delete"),
        update: () => registrar("update"),
        insert: () => registrar("insert"),
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
  log.warn.mockClear();
});

describe("conectar: os modelos seguem a conta, não a linha da conexão", () => {
  it("⭐ reapontar a conexão existente apaga, ANTES de gravar, só os modelos de OUTRA conta desta conexão", async () => {
    const r = await savePartnerSession(adminDuble(), { ...BASE, existingId: "sessao-1" });

    expect(r).toEqual({ error: null, id: "sessao-1" });
    expect(chamadas.map((c) => `${c.op}:${c.tabela}`)).toEqual([
      "delete:meta_templates",
      "update:channel_sessions",
    ]);
    // `neq` é a alma da guarda: apagar só por `channel_session_id` levaria junto
    // os modelos da conta NOVA numa reconexão com a mesma conta (trocar só a
    // chave, o caso comum) — e `eq` apagaria justamente os que valem.
    expect(chamadas[0]?.filtros).toEqual([
      ["eq", "organization_id", "org-1"],
      ["eq", "channel_session_id", "sessao-1"],
      ["neq", "waba_id", "conta-nova"],
    ]);
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
    expect(chamadas[0]?.filtros).toContainEqual(["neq", "waba_id", "conta-nova"]);
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
});
