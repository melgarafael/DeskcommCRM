/**
 * O ORQUESTRADOR da exclusão de tenant — a ordem é o desenho.
 *
 * A transação do banco está provada contra Postgres em
 * `tests/invariants/gestao-de-tenants.test.ts` e
 * `tests/invariants/exclusao-recusa-cobranca.test.ts`. Aqui se mede o que o
 * banco não vê: que as recusas acontecem ANTES de tocar em qualquer coisa
 * (inclusive a suspensão por cobrança), que as credenciais são LIDAS antes da
 * transação mas o mundo externo (WhatsApp, voz, loja) só é desligado DEPOIS do
 * commit — se o banco recusar, nada lá fora caiu —, que Storage e logins vêm
 * depois, e que um login que o GoTrue recusa apagar fica registrado como
 * mantido em vez de derrubar a exclusão.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const passos: string[] = [];

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => {
    passos.push("audit");
  }),
}));
vi.mock("@/lib/channels/desligar-da-organizacao", () => ({
  // O mapeamento lápide → inventário mora (e é testado) na fronteira de canais.
  inventarioDaLapide: vi.fn((linhas: Array<{ id: string }>) => ({
    canais: linhas.map((l) => ({ id: l.id, provider: "p", wahaSessionName: `sessao-${l.id}`, meta: null })),
    sessaoDeVoz: "voz-da-lapide",
  })),
  inventariarCanaisDaOrganizacao: vi.fn(async () => {
    passos.push("canais.inventario");
    return {
      canais: [{ id: "canal-1", provider: "qr", wahaSessionName: "s1", meta: null }],
      sessaoDeVoz: "voz-1",
    };
  }),
  desligarCanaisInventariados: vi.fn(async () => {
    passos.push("canais.desligar");
    return [{ id: "canal-1", provedor: "qr", desfecho: "ok" }];
  }),
}));
vi.mock("@/lib/wacalls/client", () => ({ getWacallsClient: () => ({}) }));
vi.mock("@/lib/voice/desparear", () => ({
  desligarSessaoDeVozNoTransporte: vi.fn(async (_w: unknown, id: string) => {
    passos.push(`voz.desligar:${id}`);
  }),
}));
vi.mock("@/lib/nuvemshop/api-client", () => ({
  NuvemshopApiClient: class {
    async deleteWebhook(id: number) {
      passos.push(`nuvemshop.desligar:${id}`);
    }
  },
}));
vi.mock("@/lib/webhooks/secrets", () => ({ decryptWebhookSecret: vi.fn(async () => "tok") }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { audit } from "@/lib/audit";
import { desligarCanaisInventariados, inventarioDaLapide } from "@/lib/channels/desligar-da-organizacao";

import { excluirOrganizacao, ExclusaoInterrompida, ExclusaoRecusada } from "./exclusao";

const ORG = "7e0a0000-0000-4000-8000-0000000000ee";
const ATOR = "7e0a1111-0000-4000-8000-0000000000ff";

interface Cenario {
  status?: string;
  suspendedKind?: string | null;
  rpcErro?: { code: string; message: string } | null;
  arquivos?: Array<{ bucket_id: string; name: string }>;
  removiveis?: string[];
  deleteUserFalhaPara?: string[];
  /** Linhas de `api_audit_log` da org (a lápide e o registro final), para a retomada. */
  auditoria?: Array<{ action: string; metadata: Record<string, unknown> }>;
  semVinculo?: string[];
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
          c.status === undefined
            ? null
            : {
                id: ORG,
                slug: "acme",
                status: c.status,
                suspended_kind: c.suspendedKind === undefined ? "administrativa" : c.suspendedKind,
              },
        );
      }
      if (tabela === "api_audit_log") {
        passos.push("lapide.leitura");
        const b: Record<string, unknown> = {};
        b.select = () => b;
        b.eq = () => b;
        b.in = () => b;
        b.then = (r: (v: unknown) => unknown) =>
          Promise.resolve({ data: c.auditoria ?? [], error: null }).then(r);
        return b;
      }
      if (tabela === "tenant_integrations") {
        passos.push("nuvemshop.inventario");
        return leituraSimples({
          oauth_access_token_encrypted: "enc",
          store_metadata: { store_id: 9 },
          webhook_subscriptions: { "order/created": { id: 77 } },
        });
      }
      if (tabela === "cobranca_assinaturas") {
        // Empresa sem linha de cobrança (isenta): a releitura de #2626 lê a
        // linha, não acha, e não chama o provedor.
        return leituraSimples(null);
      }
      throw new Error(`tabela inesperada: ${tabela}`);
    },
    rpc: vi.fn(async (fn: string, args?: unknown) => {
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
      if (fn === "fn_logins_sem_vinculo") return { data: c.semVinculo ?? [], error: null };
      if (fn === "fn_arquivos_da_organizacao") {
        // Como o PostgREST: o conjunto vem ordenado por (bucket, nome), a partir
        // do cursor, e cortado em `max_rows` (1000, supabase/config.toml) sem
        // erro nem aviso — além do `p_limite` que a função aplica.
        const a = args as { p_apos_bucket?: string | null; p_apos_nome?: string | null; p_limite?: number };
        const ordenados = [...(c.arquivos ?? [])].sort((x, y) =>
          x.bucket_id === y.bucket_id ? (x.name < y.name ? -1 : 1) : x.bucket_id < y.bucket_id ? -1 : 1,
        );
        const depois = ordenados.filter(
          (o) =>
            a.p_apos_bucket == null ||
            o.bucket_id > a.p_apos_bucket ||
            (o.bucket_id === a.p_apos_bucket && o.name > (a.p_apos_nome ?? "")),
        );
        return { data: depois.slice(0, Math.min(a.p_limite ?? Infinity, 1000)), error: null };
      }
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

const TRANSPORTE = ["canais.desligar", "voz.desligar", "nuvemshop.desligar"];
const tocouTransporte = () => passos.some((p) => TRANSPORTE.some((t) => p.startsWith(t)));

describe("recusas — nada é tocado", () => {
  it("organização ATIVA: recusa com state_conflict, sem desligar canal nem chamar o banco", async () => {
    const admin = adminFalso({ status: "active" });
    await expect(excluirOrganizacao(admin as never, entrada)).rejects.toMatchObject({
      codigo: "state_conflict",
    });
    expect(passos).toEqual([]);
  });

  it("suspensa por COBRANÇA: exclusao_com_cobranca_pendente, sem inventário, banco, transporte nem audit", async () => {
    const admin = adminFalso({ status: "suspended", suspendedKind: "cobranca" });
    await expect(excluirOrganizacao(admin as never, entrada)).rejects.toMatchObject({
      codigo: "exclusao_com_cobranca_pendente",
    });
    expect(passos).toEqual([]);
    expect(admin.rpc).not.toHaveBeenCalled();
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
  it("credenciais lidas ANTES do banco; WhatsApp, voz e loja desligados DEPOIS do commit; Storage, logins e registro por último", async () => {
    const admin = adminFalso({
      status: "suspended",
      arquivos: [
        { bucket_id: "whatsapp-media", name: `${ORG}/c/1.jpg` },
        { bucket_id: "brand-logos", name: `${ORG}/logo.png` },
      ],
      removiveis: ["u1"],
    });
    const r = await excluirOrganizacao(admin as never, entrada);

    const i = (p: string) => {
      const n = passos.findIndex((x) => x.startsWith(p));
      expect(n, `passo ${p} em ${passos.join(", ")}`).toBeGreaterThanOrEqual(0);
      return n;
    };
    const banco = i("rpc:fn_excluir_organizacao");
    expect(i("canais.inventario")).toBeLessThan(banco);
    expect(i("nuvemshop.inventario")).toBeLessThan(banco);
    for (const t of TRANSPORTE) expect(i(t)).toBeGreaterThan(banco);
    expect(i("storage:")).toBeGreaterThan(i("canais.desligar"));
    expect(i("auth.delete:u1")).toBeGreaterThan(banco);
    expect(passos.at(-1)).toBe("audit");

    expect(passos).toContain("voz.desligar:voz-1");
    expect(passos).toContain("nuvemshop.desligar:77");
    expect(r.voz).toBe("ok");
    expect(r.nuvemshop).toBe("ok");
    expect(r.arquivos).toEqual({ encontrados: 2, removidos: 2, falhas: 0 });
    expect(r.usuarios.removidos).toEqual(["u1"]);
    expect(r.canais[0]).toMatchObject({ id: "canal-1", desfecho: "ok" });
  });

  it("suspensão sem tipo (nula) vale como administrativa: a exclusão segue", async () => {
    const admin = adminFalso({ status: "suspended", suspendedKind: null });
    const r = await excluirOrganizacao(admin as never, entrada);
    expect(r.slug).toBe("acme");
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
});

describe("Storage além de uma página", () => {
  it("1.200 arquivos: todos removidos — o corte de 1000 linhas do PostgREST não vira 'terminou'", async () => {
    const arquivos = Array.from({ length: 1200 }, (_, i) => ({
      bucket_id: i % 3 === 0 ? "brand-logos" : "whatsapp-media",
      name: `${ORG}/f/${String(i).padStart(5, "0")}.bin`,
    }));
    const admin = adminFalso({ status: "suspended", arquivos });
    const r = await excluirOrganizacao(admin as never, entrada);
    expect(r.arquivos).toEqual({ encontrados: 1200, removidos: 1200, falhas: 0 });
    const removidos = passos
      .filter((p) => p.startsWith("storage:"))
      .reduce((n, p) => n + Number(p.split(":")[2]), 0);
    expect(removidos).toBe(1200);
  });
});

describe("o banco recusou — nada lá fora caiu", () => {
  it("PT409 (corrida com reativação) vira state_conflict; zero transporte, Storage, logins e audit", async () => {
    const admin = adminFalso({
      status: "suspended",
      rpcErro: { code: "PT409", message: "organizacao_nao_suspensa" },
      removiveis: ["u1"],
    });
    await expect(excluirOrganizacao(admin as never, entrada)).rejects.toMatchObject({
      codigo: "state_conflict",
    });
    expect(tocouTransporte()).toBe(false);
    expect(passos.some((p) => p.startsWith("storage:") || p.startsWith("auth.delete"))).toBe(false);
    expect(audit).not.toHaveBeenCalled();
  });

  it("PT409 organizacao_com_cobranca_pendente (o tipo virou cobrança no meio) vira exclusao_com_cobranca_pendente", async () => {
    const admin = adminFalso({
      status: "suspended",
      rpcErro: { code: "PT409", message: "organizacao_com_cobranca_pendente" },
    });
    await expect(excluirOrganizacao(admin as never, entrada)).rejects.toMatchObject({
      codigo: "exclusao_com_cobranca_pendente",
    });
    expect(tocouTransporte()).toBe(false);
  });

  it("PT409 organizacao_com_assinatura_viva (gatilho da 0601, suspensa pelo administrador): código e mensagem próprios", async () => {
    const admin = adminFalso({
      status: "suspended",
      rpcErro: { code: "PT409", message: "organizacao_com_assinatura_viva" },
    });
    const recusa = await excluirOrganizacao(admin as never, entrada).catch((e: unknown) => e);
    expect(recusa).toBeInstanceOf(ExclusaoRecusada);
    expect(recusa).toMatchObject({ codigo: "exclusao_com_assinatura_viva" });
    const mensagem = (recusa as Error).message;
    expect(mensagem).toMatch(/assinatura ativa/);
    expect(mensagem).toMatch(/Cancele a assinatura antes de excluir/);
    // As duas frases erradas para este caso: não é falta de pagamento, e a org segue suspensa.
    expect(mensagem).not.toMatch(/falta de pagamento|não está mais suspensa/);
    expect(tocouTransporte()).toBe(false);
    expect(audit).not.toHaveBeenCalled();
  });

  it("a resposta da rpc se perdeu (sem código): ExclusaoInterrompida — o commit pode ter acontecido, 'nada foi apagado' seria falso", async () => {
    const admin = adminFalso({
      status: "suspended",
      rpcErro: { code: "", message: "TypeError: fetch failed" },
    });
    await expect(excluirOrganizacao(admin as never, entrada)).rejects.toBeInstanceOf(
      ExclusaoInterrompida,
    );
  });

  it("erro qualquer da transação: lança, e o WhatsApp, a voz e a loja seguem ligados", async () => {
    const admin = adminFalso({
      status: "suspended",
      rpcErro: { code: "P0001", message: "organizacao_exclusao_incompleta" },
    });
    await expect(excluirOrganizacao(admin as never, entrada)).rejects.toThrow(/exclusao_banco/);
    expect(tocouTransporte()).toBe(false);
  });
});

describe("interrompida depois do commit — a nova tentativa retoma", () => {
  const LAPIDE = {
    action: "organization.deleted",
    metadata: {
      slug: "acme",
      contagens: { membros: 2 },
      membros: ["u1", "u2"],
      inventario_externo: {
        canais: [{ id: "c-1" }, { id: "c-2" }],
        nuvemshop_store_id: "9",
      },
    },
  };

  it("um throw depois do commit vira ExclusaoInterrompida, não o 'nada foi apagado'", async () => {
    vi.mocked(desligarCanaisInventariados).mockRejectedValueOnce(new Error("processo caiu"));
    const admin = adminFalso({ status: "suspended" });
    await expect(excluirOrganizacao(admin as never, entrada)).rejects.toBeInstanceOf(
      ExclusaoInterrompida,
    );
  });

  it("org já apagada, lápide sem registro final: refaz transporte possível, Storage e logins a partir da lápide", async () => {
    const admin = adminFalso({
      auditoria: [LAPIDE],
      semVinculo: ["u1"],
      arquivos: [{ bucket_id: "whatsapp-media", name: `${ORG}/x.jpg` }],
    });
    const r = await excluirOrganizacao(admin as never, entrada);

    // Os canais da lápide viram o inventário, e é ESSE que vai ao transporte.
    expect(inventarioDaLapide).toHaveBeenCalledWith([{ id: "c-1" }, { id: "c-2" }]);
    const inventario = vi.mocked(desligarCanaisInventariados).mock.calls[0]![0];
    expect(inventario.canais.map((c) => c.wahaSessionName)).toEqual(["sessao-c-1", "sessao-c-2"]);
    expect(passos).toContain("voz.desligar:voz-da-lapide");
    // O token da loja só existia em memória: a loja vai para o registro como falha.
    expect(r.nuvemshop).toBe("falhou");
    expect(r.arquivos).toEqual({ encontrados: 1, removidos: 1, falhas: 0 });
    expect(admin.rpc).toHaveBeenCalledWith("fn_logins_sem_vinculo", { p_users: ["u1", "u2"] });
    expect(r.usuarios.removidos).toEqual(["u1"]);
    expect(admin.rpc).not.toHaveBeenCalledWith("fn_excluir_organizacao", expect.anything());
    const final = vi.mocked(audit).mock.calls.at(-1)![0] as { action: string; metadata: Record<string, unknown> };
    expect(final.action).toBe("organization.deletion_completed");
    expect(final.metadata.retomada).toBe(true);
  });

  it("registro final já existe: not_found, nada é refeito", async () => {
    const admin = adminFalso({
      auditoria: [LAPIDE, { action: "organization.deletion_completed", metadata: {} }],
    });
    await expect(excluirOrganizacao(admin as never, entrada)).rejects.toMatchObject({ codigo: "not_found" });
    expect(desligarCanaisInventariados).not.toHaveBeenCalled();
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it("retomada com identificador que não é o da lápide: confirmacao_divergente, nada é refeito", async () => {
    const admin = adminFalso({ auditoria: [LAPIDE] });
    await expect(
      excluirOrganizacao(admin as never, { ...entrada, confirmacao: "outra" }),
    ).rejects.toMatchObject({ codigo: "confirmacao_divergente" });
    expect(desligarCanaisInventariados).not.toHaveBeenCalled();
  });
});
