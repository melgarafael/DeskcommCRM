/**
 * O ORQUESTRADOR da exclusão de tenant — a ordem é o desenho.
 *
 * A transação do banco está provada contra Postgres em
 * `tests/invariants/gestao-de-tenants.test.ts`. Aqui se mede o que o banco não
 * vê: que as recusas acontecem ANTES de tocar em qualquer coisa, que o que fala
 * com o mundo sai ANTES da transação (as credenciais moram nas linhas que ela
 * apaga), que Storage e logins vêm DEPOIS, e que um login que o GoTrue recusa
 * apagar fica registrado como mantido em vez de derrubar a exclusão.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const passos: string[] = [];

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => {
    passos.push("audit");
  }),
}));
vi.mock("@/lib/channels/desligar-da-organizacao", () => ({
  desligarCanaisDaOrganizacao: vi.fn(async () => {
    passos.push("canais.desligar");
    return [{ id: "canal-1", provedor: "qr", desfecho: "ok" }];
  }),
}));
vi.mock("@/lib/wacalls/client", () => ({ getWacallsClient: () => null }));
vi.mock("@/lib/voice/desparear", () => ({ despareaVoz: vi.fn() }));
vi.mock("@/lib/webhooks/secrets", () => ({ decryptWebhookSecret: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { audit } from "@/lib/audit";

import { excluirOrganizacao, ExclusaoRecusada } from "./exclusao";

const ORG = "7e0a0000-0000-4000-8000-0000000000ee";
const ATOR = "7e0a1111-0000-4000-8000-0000000000ff";

interface Cenario {
  status?: string;
  rpcErro?: { code: string; message: string } | null;
  arquivos?: Array<{ bucket_id: string; name: string }>;
  removiveis?: string[];
  deleteUserFalhaPara?: string[];
}

function adminFalso(c: Cenario) {
  const leituraSimples = (data: unknown) => {
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = () => b;
    b.maybeSingle = async () => ({ data, error: null });
    b.then = (r: (v: unknown) => unknown) => Promise.resolve({ data, error: null }).then(r);
    return b;
  };
  return {
    from: (tabela: string) => {
      if (tabela === "organizations") {
        return leituraSimples(
          c.status === undefined ? null : { id: ORG, slug: "acme", status: c.status },
        );
      }
      if (tabela === "tenant_integrations") return leituraSimples(null);
      throw new Error(`tabela inesperada: ${tabela}`);
    },
    rpc: vi.fn(async (fn: string) => {
      passos.push(`rpc:${fn}`);
      if (fn === "fn_excluir_organizacao") {
        if (c.rpcErro) return { data: null, error: c.rpcErro };
        return {
          data: {
            slug: "acme",
            contagens: { membros: 2 },
            usuarios_removiveis: c.removiveis ?? [],
          },
          error: null,
        };
      }
      if (fn === "fn_arquivos_da_organizacao") return { data: c.arquivos ?? [], error: null };
      throw new Error(`rpc inesperada: ${fn}`);
    }),
    storage: {
      from: (bucket: string) => ({
        remove: vi.fn(async (nomes: string[]) => {
          passos.push(`storage:${bucket}:${nomes.length}`);
          return { error: null };
        }),
      }),
    },
    auth: {
      admin: {
        deleteUser: vi.fn(async (id: string) => {
          passos.push(`auth.delete:${id}`);
          return (c.deleteUserFalhaPara ?? []).includes(id)
            ? { error: { message: "violates foreign key constraint" } }
            : { error: null };
        }),
      },
    },
  };
}

const entrada = {
  orgId: ORG,
  atorId: ATOR,
  confirmacao: "acme",
  motivo: "contrato encerrado pelo cliente",
  requestId: "req-1",
};

beforeEach(() => {
  passos.length = 0;
  vi.clearAllMocks();
});

describe("recusas — nada é tocado", () => {
  it("organização ATIVA: recusa com state_conflict, sem desligar canal nem chamar o banco", async () => {
    const admin = adminFalso({ status: "active" });
    await expect(excluirOrganizacao(admin as never, entrada)).rejects.toMatchObject({
      codigo: "state_conflict",
    });
    expect(passos).toEqual([]);
  });

  it("confirmação que não é o slug: recusa", async () => {
    const admin = adminFalso({ status: "suspended" });
    await expect(
      excluirOrganizacao(admin as never, { ...entrada, confirmacao: "outra" }),
    ).rejects.toMatchObject({ codigo: "confirmacao_divergente" });
    expect(passos).toEqual([]);
  });

  it("organização inexistente: not_found", async () => {
    const admin = adminFalso({});
    await expect(excluirOrganizacao(admin as never, entrada)).rejects.toBeInstanceOf(
      ExclusaoRecusada,
    );
  });

  it("motivo curto: recusa antes de ler o banco", async () => {
    const admin = adminFalso({ status: "suspended" });
    await expect(
      excluirOrganizacao(admin as never, { ...entrada, motivo: "curto" }),
    ).rejects.toMatchObject({ codigo: "motivo_curto" });
  });
});

describe("a ordem", () => {
  it("canal externo ANTES do banco; Storage e logins DEPOIS; registro final por último", async () => {
    const admin = adminFalso({
      status: "suspended",
      arquivos: [
        { bucket_id: "whatsapp-media", name: `${ORG}/c/1.jpg` },
        { bucket_id: "brand-logos", name: `${ORG}/logo.png` },
      ],
      removiveis: ["u1"],
    });
    const r = await excluirOrganizacao(admin as never, entrada);

    const i = (p: string) => passos.findIndex((x) => x.startsWith(p));
    expect(i("canais.desligar")).toBeLessThan(i("rpc:fn_excluir_organizacao"));
    expect(i("rpc:fn_excluir_organizacao")).toBeLessThan(i("storage:"));
    expect(i("rpc:fn_excluir_organizacao")).toBeLessThan(i("auth.delete:u1"));
    expect(passos.at(-1)).toBe("audit");

    expect(r.arquivos).toEqual({ encontrados: 2, removidos: 2, falhas: 0 });
    expect(r.usuarios.removidos).toEqual(["u1"]);
    expect(r.canais[0]).toMatchObject({ id: "canal-1", desfecho: "ok" });
  });

  it("login que o GoTrue recusa apagar fica como MANTIDO — a exclusão não cai", async () => {
    const admin = adminFalso({
      status: "suspended",
      removiveis: ["u1", "u2"],
      deleteUserFalhaPara: ["u2"],
    });
    const r = await excluirOrganizacao(admin as never, entrada);
    expect(r.usuarios.removidos).toEqual(["u1"]);
    expect(r.usuarios.mantidos.map((m) => m.id)).toEqual(["u2"]);
  });

  it("recusa do banco (PT409, corrida com reativação) vira state_conflict, e Storage/logins não rodam", async () => {
    const admin = adminFalso({
      status: "suspended",
      rpcErro: { code: "PT409", message: "organizacao_nao_suspensa" },
      removiveis: ["u1"],
    });
    await expect(excluirOrganizacao(admin as never, entrada)).rejects.toMatchObject({
      codigo: "state_conflict",
    });
    expect(passos.some((p) => p.startsWith("storage:") || p.startsWith("auth.delete"))).toBe(false);
    expect(audit).not.toHaveBeenCalled();
  });
});
