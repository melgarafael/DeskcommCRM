import { beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ saude: vi.fn(), warn: vi.fn() }));
vi.mock("@/lib/webhooks/secrets", () => ({
  decryptWebhookSecret: async () => "provider-key",
  encryptWebhookSecret: async () => "enc",
}));
vi.mock("@/lib/channels/health", () => ({ resolverSaudeDaConexaoRemovida: h.saude }));
vi.mock("@/lib/logger", () => ({ logger: { warn: h.warn, info: vi.fn(), error: vi.fn() } }));

import { desvincularPerfilSocial } from "./store";

const org = "org-1";

function fakeDb(ativas: Record<string, unknown>[], todas: Record<string, unknown>[], integracao: boolean) {
  const apagou: string[] = [];
  const db = {
    from(tabela: string) {
      const filtros: Record<string, unknown> = {};
      let apagar = false;
      let colunas = "";
      const q = {
        select: (c = "*") => ((colunas = c), q),
        delete: () => ((apagar = true), q),
        update: () => q,
        eq: (k: string, v: unknown) => ((filtros[k] = v), q),
        is: (k: string, v: unknown) => ((filtros[k] = v), q),
        maybeSingle: async () => {
          if (apagar) {
            if (tabela === "channel_integrations" && integracao) {
              apagou.push(tabela);
              return { data: { organization_id: org }, error: null };
            }
            return { data: null, error: null };
          }
          return { data: null, error: null };
        },
        then: (resolve: (r: unknown) => void) => {
          // socialChannels pede as colunas cheias (só ativas); a varredura de
          // avisos pede só `id` (ativas + arquivadas).
          const linhas = tabela === "channel_sessions" ? (colunas === "id" ? todas : ativas) : null;
          resolve({ data: linhas, error: null });
        },
      };
      return q;
    },
  };
  return { db: db as never, apagou };
}

const canal = {
  id: "ch-1",
  zernio_account_id: "a".repeat(24),
  display_name: "Instagram · velha",
  status: "WORKING",
  metadata: {},
  updated_at: "2026-10-06T00:00:00Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  h.saude.mockResolvedValue("sem_mudanca");
});

it("recusa com 409 quando há canal social ativo, sem apagar nada", async () => {
  const { db, apagou } = fakeDb([canal], [canal], true);
  await expect(desvincularPerfilSocial(db, org)).rejects.toMatchObject({
    status: 409,
  });
  await expect(desvincularPerfilSocial(db, org)).rejects.toThrow(/Arquive ou exclua/);
  expect(apagou).toEqual([]);
  expect(h.saude).not.toHaveBeenCalled();
});

it("apaga a integração mesmo sem sessão restante", async () => {
  const { db, apagou } = fakeDb([], [], true);
  await expect(desvincularPerfilSocial(db, org)).resolves.toEqual({
    desvinculado: true,
    avisos_fechados: "sem_mudanca",
  });
  expect(apagou).toEqual(["channel_integrations"]);
  expect(h.saude).not.toHaveBeenCalled();
});

it("fecha os avisos das sessões arquivadas que restaram", async () => {
  h.saude.mockResolvedValue("resolvido");
  const arquivada = { id: "ch-velha" };
  const { db, apagou } = fakeDb([], [arquivada], true);
  await expect(desvincularPerfilSocial(db, org)).resolves.toEqual({
    desvinculado: true,
    avisos_fechados: "resolvido",
  });
  expect(apagou).toEqual(["channel_integrations"]);
  expect(h.saude).toHaveBeenCalledWith(db, {
    id: "ch-velha",
    organization_id: org,
    status: "STOPPED",
  });
});

it("devolve 404 quando não há perfil vinculado", async () => {
  const { db, apagou } = fakeDb([], [], false);
  await expect(desvincularPerfilSocial(db, org)).rejects.toMatchObject({ status: 404 });
  expect(apagou).toEqual([]);
});

it("não desfaz a desvinculação quando o fecho dos avisos falha", async () => {
  h.saude.mockRejectedValue(new Error("ler os avisos abertos: 500"));
  const { db, apagou } = fakeDb([], [{ id: "ch-velha" }], true);
  await expect(desvincularPerfilSocial(db, org)).resolves.toEqual({
    desvinculado: true,
    avisos_fechados: "falhou",
  });
  expect(apagou).toEqual(["channel_integrations"]);
  expect(h.warn).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ organization_id: org }),
  );
});
