import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/automation/outbound-ip", () => ({
  assertDestinoResolvidoSeguro: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/automation/outbound-url", () => ({
  assertSafeOutboundUrl: vi.fn(),
}));

import { assertDestinoResolvidoSeguro } from "@/lib/automation/outbound-ip";
import { assertSafeOutboundUrl } from "@/lib/automation/outbound-url";
import { ryzeAdapter, sanitizeRyzeError } from "@/lib/channels/adapters/ryze";
import { resolveRyzeCreds } from "@/lib/channels/ryze/credentials";
import {
  listRyzeInstances,
  provisionRyzeInstance,
  persistRyzeSession,
  getRyzeAccountToken,
} from "@/lib/channels/ryze/control-plane";
import type { OutboundEnvelope } from "@/lib/channels/types";

describe("adapter outbound ryze & control plane (F3)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(assertDestinoResolvidoSeguro).mockResolvedValue(undefined);
    vi.mocked(assertSafeOutboundUrl).mockReturnValue(undefined);
  });

  describe("resolveRecipient", () => {
    it("resolve grupo quando isGroup e groupChatId fornecido", () => {
      const recipient = ryzeAdapter.resolveRecipient({
        isGroup: true,
        groupChatId: "123456789@g.us",
        phoneNumber: null,
        waIdentity: null,
      });
      expect(recipient).toBe("123456789@g.us");
    });

    it("resolve telefone formatando apenas dígitos", () => {
      const recipient = ryzeAdapter.resolveRecipient({
        isGroup: false,
        groupChatId: null,
        phoneNumber: "+55 (11) 99999-8888",
        waIdentity: null,
      });
      expect(recipient).toBe("5511999998888");
    });

    it("resolve waIdentity com prefixo phone:", () => {
      const recipient = ryzeAdapter.resolveRecipient({
        isGroup: false,
        groupChatId: null,
        phoneNumber: null,
        waIdentity: "phone:+5511999997777",
      });
      expect(recipient).toBe("5511999997777");
    });

    it("retorna null se nenhum destinatario valido for informado", () => {
      const recipient = ryzeAdapter.resolveRecipient({
        isGroup: false,
        groupChatId: null,
        phoneNumber: null,
        waIdentity: null,
      });
      expect(recipient).toBeNull();
    });
  });

  describe("resolveRyzeCreds (isolamento por tenant)", () => {
    it("isola por organizationId e ryze_instance_name", async () => {
      const mockMaybeSingle = vi.fn().mockResolvedValue({
        data: {
          ryze_instance_name: "instancia_org_a",
          ryze_token_encrypted: Buffer.from("token_cifrado"),
        },
        error: null,
      });

      const fakeDb = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        maybeSingle: mockMaybeSingle,
        rpc: vi.fn().mockResolvedValue({ data: "token_descriptografado", error: null }),
      } as any;

      const creds = await resolveRyzeCreds(fakeDb, {
        organizationId: "org-uuid-111",
        instanceName: "instancia_org_a",
      });

      expect(fakeDb.from).toHaveBeenCalledWith("channel_sessions");
      expect(fakeDb.eq).toHaveBeenCalledWith("organization_id", "org-uuid-111");
      expect(fakeDb.eq).toHaveBeenCalledWith("provider", "ryze");
      expect(fakeDb.eq).toHaveBeenCalledWith("ryze_instance_name", "instancia_org_a");
      expect(creds).not.toBeNull();
      expect(creds?.tokenInstance).toBe("token_descriptografado");
    });

    it("retorna null se a org errada tentar ler credencial de outra org (cross-tenant)", async () => {
      const fakeDb = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      } as any;

      const creds = await resolveRyzeCreds(fakeDb, {
        organizationId: "org-uuid-vitima",
        instanceName: "instancia_alheia",
      });

      expect(creds).toBeNull();
    });
  });

  describe("control plane & provisionamento (fail-closed & idempotencia)", () => {
    it("obtem account token do runtime sem imprimir", () => {
      process.env.RYZE_ACCOUNT_TOKEN = "secret_acc_token_123";
      const token = getRyzeAccountToken();
      expect(token).toBe("secret_acc_token_123");
    });

    it("listRyzeInstances falha fechado em HTTP 200 com payload nao-JSON, success=false ou sem campo instances", async () => {
      process.env.RYZE_ACCOUNT_TOKEN = "acc_token_xyz";

      // 1. Resposta não-JSON
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => { throw new Error("bad json"); },
      }));
      await expect(listRyzeInstances()).rejects.toThrow("ryze_instance_list_invalid_response");

      // 2. success: false
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ success: false }),
      }));
      await expect(listRyzeInstances()).rejects.toThrow("ryze_instance_list_invalid_response");

      // 3. Objeto sem campo instances
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ success: true }),
      }));
      await expect(listRyzeInstances()).rejects.toThrow("ryze_instance_list_invalid_response");
    });

    it("garante zero chamadas a CREATE se a listagem retornar resposta malformada ou invalida", async () => {
      process.env.RYZE_ACCOUNT_TOKEN = "acc_token_xyz";
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ success: true }), // sem o array instances
      });
      vi.stubGlobal("fetch", mockFetch);

      const fakeDb = {} as any;
      await expect(
        provisionRyzeInstance({ organizationId: "org-1", instanceName: "inst1", db: fakeDb })
      ).rejects.toThrow("ryze_instance_list_invalid_response");

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).not.toHaveBeenCalledWith("https://ryzeapi.cloud/api/instance/new", expect.anything());
    });

    it("recusa CREATE quando a instancia ja existe no plano de controle mas nao possui token nem credencial salva", async () => {
      process.env.RYZE_ACCOUNT_TOKEN = "acc_token_xyz";
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          instances: [{ id: "1", name: "vivo1203" }],
        }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const fakeDb = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      } as any;

      await expect(
        provisionRyzeInstance({
          organizationId: "org-100",
          instanceName: "vivo1203",
          db: fakeDb,
        })
      ).rejects.toThrow("ryze_existing_instance_token_unavailable");

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).not.toHaveBeenCalledWith("https://ryzeapi.cloud/api/instance/new", expect.anything());
    });

    it("falha fechado com erro explicito se encryptWebhookSecret retornar null (zero DB writes)", async () => {
      process.env.RYZE_ACCOUNT_TOKEN = "acc_token_xyz";
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          instances: [{ id: "1", name: "instancia_test", token: "tok_test" }],
        }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const fakeInsert = vi.fn();
      const fakeUpdate = vi.fn();
      const fakeDb = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        insert: fakeInsert,
        update: fakeUpdate,
        rpc: vi.fn().mockResolvedValue({ data: null, error: "encrypt_failed" }),
      } as any;

      await expect(
        provisionRyzeInstance({
          organizationId: "org-100",
          instanceName: "instancia_test",
          db: fakeDb,
        })
      ).rejects.toThrow("ryze_control_encrypt_failed");

      expect(fakeInsert).not.toHaveBeenCalled();
      expect(fakeUpdate).not.toHaveBeenCalled();
    });

    it("falha fechado quando lookup tenant-aware retorna erro e não tenta INSERT/UPDATE", async () => {
      const fakeInsert = vi.fn();
      const fakeUpdate = vi.fn();
      const fakeDb = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: { message: "db unavailable" } }),
        insert: fakeInsert,
        update: fakeUpdate,
      } as any;

      await expect(persistRyzeSession(fakeDb, {
        organizationId: "org-fail-closed",
        instanceName: "inst-fail-closed",
        encryptedToken: "\\x1234",
        webhookSecretEncrypted: "\\xwebhook",
      })).rejects.toThrow("ryze_session_lookup_failed");

      expect(fakeInsert).not.toHaveBeenCalled();
      expect(fakeUpdate).not.toHaveBeenCalled();
    });

    it("usa o ciphertext retornado pelo helper de criptografia no INSERT e não o plaintext gerado", async () => {
      process.env.RYZE_ACCOUNT_TOKEN = "acc_token_xyz";
      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true, instances: [] }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true, instance: { name: "inst-cipher", token: "instance-token" } }) }));

      const fakeInsert = vi.fn().mockResolvedValue({ data: { id: "sess-cipher" }, error: null });
      const fakeDb = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        insert: fakeInsert,
        rpc: vi.fn()
          .mockResolvedValueOnce({ data: "\\x776562686f6f6b_cipher", error: null })
          .mockResolvedValueOnce({ data: "\\x746f6b656e_cipher", error: null }),
      } as any;

      await provisionRyzeInstance({ organizationId: "org-cipher", instanceName: "inst-cipher", db: fakeDb });

      expect(fakeInsert).toHaveBeenCalledWith(expect.objectContaining({
        ryze_token_encrypted: "\\x746f6b656e_cipher",
        webhook_secret_encrypted: "\\x776562686f6f6b_cipher",
      }));
      expect(JSON.stringify(fakeInsert.mock.calls[0]?.[0])).not.toContain("instance-token");
    });
    it("usa apenas os shapes oficiais instance.token e data.token e falha fechado nos demais", async () => {
      const run = async (createResponse: unknown, expectedToken?: string) => {
        const mockFetch = vi.fn()
          .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true, instances: [] }) })
          .mockResolvedValueOnce({ ok: true, status: 200, json: async () => createResponse });
        vi.stubGlobal("fetch", mockFetch);
        const fakeInsert = vi.fn().mockResolvedValue({ data: { id: "sess-shape" }, error: null });
        const fakeDb = {
          from: vi.fn().mockReturnThis(), select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), is: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }), insert: fakeInsert,
          rpc: vi.fn().mockResolvedValue({ data: "\\x636970686572", error: null }),
        } as any;

        if (expectedToken) {
          await provisionRyzeInstance({ organizationId: "org-shape", instanceName: "inst-shape", db: fakeDb });
          expect(fakeInsert).toHaveBeenCalledWith(expect.objectContaining({ ryze_token_encrypted: "\\x636970686572" }));
        } else {
          await expect(provisionRyzeInstance({ organizationId: "org-shape", instanceName: "inst-shape", db: fakeDb })).rejects.toThrow(/ryze_instance_create_invalid_response|ryze_token_instance_missing/);
          expect(fakeInsert).not.toHaveBeenCalled();
        }
      };

      await run({ success: true, instance: { name: "inst-shape", token: "instance-token" } }, "instance-token");
      await run({ success: true, data: { name: "inst-shape", token: "data-token" } }, "data-token");
      await run({ success: false, data: { token: "ignored-token" } });
      await run({ success: true, instance: { name: "inst-shape" } });
    });
    it("congela o contract-test do CREATE não idempotente e falha fechado em resposta non-JSON", async () => {
      process.env.RYZE_ACCOUNT_TOKEN = "TOKEN_ACCOUNT_SYNTHETIC";
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true, instances: [] }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => { throw new Error("non-json"); } });
      vi.stubGlobal("fetch", mockFetch);

      const fakeInsert = vi.fn();
      const fakeUpdate = vi.fn();
      const fakeDb = {
        from: vi.fn().mockReturnThis(), select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), is: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }), insert: fakeInsert, update: fakeUpdate,
        rpc: vi.fn().mockResolvedValue({ data: "\\x636970686572", error: null }),
      } as any;

      await expect(provisionRyzeInstance({ organizationId: "org-contract", instanceName: "inst-contract", db: fakeDb })).rejects.toThrow("ryze_instance_create_invalid_response");

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch).toHaveBeenNthCalledWith(2, "https://ryzeapi.cloud/api/instance/new", {
        method: "POST",
        headers: { "Content-Type": "application/json", token: "TOKEN_ACCOUNT_SYNTHETIC" },
        body: JSON.stringify({ name: "inst-contract" }),
      });
      expect(mockFetch.mock.calls.filter(([url]) => String(url).includes("/api/instance/create"))).toHaveLength(0);
      expect(fakeInsert).not.toHaveBeenCalled();
      expect(fakeUpdate).not.toHaveBeenCalled();
    });
    it("falha antes do CREATE quando a cifragem prévia do webhook secret falha", async () => {
      process.env.RYZE_ACCOUNT_TOKEN = "acc_token_xyz";
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true, instances: [] }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true, instance: { name: "inst-webhook-fail", token: "instance-token" } }) });
      vi.stubGlobal("fetch", mockFetch);

      const fakeInsert = vi.fn();
      const fakeUpdate = vi.fn();
      const fakeDb = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        insert: fakeInsert,
        update: fakeUpdate,
        rpc: vi.fn()
          .mockResolvedValueOnce({ data: null, error: { message: "webhook encryption failed" } }),
      } as any;

      await expect(provisionRyzeInstance({
        organizationId: "org-webhook-fail",
        instanceName: "inst-webhook-fail",
        db: fakeDb,
      })).rejects.toThrow("ryze_control_webhook_encrypt_failed");

      expect(fakeInsert).not.toHaveBeenCalled();
      expect(fakeUpdate).not.toHaveBeenCalled();
      expect(mockFetch.mock.calls.filter(([url]) => String(url).includes("/api/instance/new"))).toHaveLength(0);
      expect(JSON.stringify(fakeInsert.mock.calls)).not.toContain("instance-token");
    });
    it("recupera após falha de persistência sem executar CREATE novamente quando LIST retorna TokenInstance", async () => {
      process.env.RYZE_ACCOUNT_TOKEN = "acc_token_xyz";
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true, instances: [] }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true, instance: { name: "inst-recover", token: "created-token" } }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true, instances: [{ name: "inst-recover", token: "recovered-token" }] }) });
      vi.stubGlobal("fetch", mockFetch);

      const fakeInsert = vi.fn()
        .mockResolvedValueOnce({ data: null, error: { message: "transient persistence failure" } })
        .mockResolvedValueOnce({ data: { id: "sess-recovered" }, error: null });
      const fakeDb = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        insert: fakeInsert,
        rpc: vi.fn()
          .mockResolvedValueOnce({ data: "\\x776562_pre", error: null })
          .mockResolvedValueOnce({ data: "\\x746f6b_created", error: null })
          .mockResolvedValueOnce({ data: "\\x746f6b_recovered", error: null })
          .mockResolvedValueOnce({ data: "\\x776562_retry", error: null }),
      } as any;

      await expect(provisionRyzeInstance({ organizationId: "org-recover", instanceName: "inst-recover", db: fakeDb })).rejects.toThrow("ryze_session_persistence_failed");
      await expect(provisionRyzeInstance({ organizationId: "org-recover", instanceName: "inst-recover", db: fakeDb })).resolves.toEqual({ instanceName: "inst-recover", isNew: false });

      expect(mockFetch.mock.calls.filter(([url]) => String(url).includes("/api/instance/new"))).toHaveLength(1);
      expect(fakeInsert).toHaveBeenCalledTimes(2);
    });
    it("reexecucao sequencial (repeated provision) e estritamente idempotente (segundo cycle tem zero chamadas de CREATE)", async () => {
      process.env.RYZE_ACCOUNT_TOKEN = "acc_token_xyz";

      // 1ª execução: lista vazia -> dispara CREATE -> salva no banco
      // 2ª execução: lista retorna a instância já existente com token -> reutiliza com zero CREATE
      let mockFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ success: true, instances: [] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ success: true, instance: { name: "inst_idempotent", token: "tok_idempotent" } }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            instances: [{ id: "2", name: "inst_idempotent", token: "tok_idempotent" }],
          }),
        });

      vi.stubGlobal("fetch", mockFetch);

      const fakeInsert = vi.fn().mockResolvedValue({ data: { id: "sess-1" }, error: null });
      const fakeSelect = vi.fn()
        .mockResolvedValueOnce({ data: null, error: null }) // 1º cycle: lookup do provisionamento
        .mockResolvedValueOnce({ data: null, error: null }) // 1º cycle: lookup da persistência
        .mockResolvedValueOnce({ data: { id: "sess-1" }, error: null }) // 2º cycle: lookup do provisionamento
        .mockResolvedValueOnce({ data: { id: "sess-1" }, error: null }); // 2º cycle: lookup da persistência

      const fakeDb = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        maybeSingle: fakeSelect,
        insert: fakeInsert,
        update: vi.fn().mockReturnThis(),
        rpc: vi.fn().mockResolvedValue({ data: "\\x636970686572", error: null }),
      } as any;

      // Primeiro ciclo (Criação inicial)
      const res1 = await provisionRyzeInstance({ organizationId: "org-100", instanceName: "inst_idempotent", db: fakeDb });
      expect(res1.isNew).toBe(true);

      // Segundo ciclo (Reexecução)
      const res2 = await provisionRyzeInstance({ organizationId: "org-100", instanceName: "inst_idempotent", db: fakeDb });
      expect(res2.isNew).toBe(false);

      // Contagem total de chamadas ao endpoint CREATE: exatamente 1 (no 1º ciclo; 0 no 2º ciclo)
      const createCalls = mockFetch.mock.calls.filter(([url]) => url.includes("/api/instance/new"));
      expect(createCalls).toHaveLength(1);
    });

    it("persistRyzeSession executa INSERT se a sessao for nova ou UPDATE pelo id da org se ja existir", async () => {
      // Branch 1: INSERT para nova sessão
      const mockInsert = vi.fn().mockResolvedValue({ data: { id: "new-sess-id" }, error: null });
      const fakeDbInsert = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        insert: mockInsert,
      } as any;

      const resInsert = await persistRyzeSession(fakeDbInsert, {
        organizationId: "org-test",
        instanceName: "inst-test",
        encryptedToken: "\\x1234",
        webhookSecretEncrypted: "\\xwebhook",
      });
      expect(resInsert.action).toBe("inserted");
      expect(mockInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          organization_id: "org-test",
          provider: "ryze",
          ryze_instance_name: "inst-test",
          webhook_secret_encrypted: "\\xwebhook",
          metadata: {},
        })
      );

      // Branch 2: UPDATE para sessão existente
      const mockUpdate = vi.fn().mockReturnThis();
      const fakeDbUpdate = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: { id: "existing-sess-id" }, error: null }),
        update: mockUpdate,
        then: (cb: any) => Promise.resolve({ data: null, error: null }).then(cb),
      } as any;

      const resUpdate = await persistRyzeSession(fakeDbUpdate, {
        organizationId: "org-test",
        instanceName: "inst-test",
        encryptedToken: "\\x5678",
      });
      expect(resUpdate.action).toBe("updated");
      expect(resUpdate.id).toBe("existing-sess-id");
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          ryze_token_encrypted: "\\x5678",
        })
      );
    });
  });

  describe("send (envio de mensagem & SSRF & sanitizacao)", () => {
    it("passa SOMENTE o hostname (ryzeapi.cloud) ao guard DNS assertDestinoResolvidoSeguro", async () => {
      const fakeDb = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: {
            ryze_instance_name: "instancia_a",
            ryze_token_encrypted: Buffer.from("enc_token"),
          },
          error: null,
        }),
        rpc: vi.fn().mockResolvedValue({ data: "my_ryze_token", error: null }),
      } as any;

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: { messageId: "ryze_msg_999" } }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const envelope: OutboundEnvelope = {
        organizationId: "org-100",
        sessionRef: "instancia_a",
        to: "5511999998888",
        kind: "text",
        body: "Ola Ryze!",
        db: fakeDb,
      } as any;

      await ryzeAdapter.send(envelope);

      expect(assertSafeOutboundUrl).toHaveBeenCalledWith("https://ryzeapi.cloud/");
      expect(assertDestinoResolvidoSeguro).toHaveBeenCalledWith("ryzeapi.cloud");
      expect(assertDestinoResolvidoSeguro).not.toHaveBeenCalledWith("https://ryzeapi.cloud");
    });

    it("sanitiza mensagens de erro adversarias impedindo vazamento de token", () => {
      const syntheticToken = "SECRET_TOKEN_RYZE_999";
      const rawError = { code: "AUTH_ERROR", error: `Invalid token supplied: ${syntheticToken}` };

      const sanitized = sanitizeRyzeError(400, rawError, syntheticToken);

      expect(sanitized).not.toContain(syntheticToken);
      expect(sanitized).toContain("[REDACTED]");
    });

    it("mapeia erros HTTP conforme matriz de erros (401, 403, 404, 429, 500, 503)", async () => {
      const fakeDb = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: {
            ryze_instance_name: "instancia_a",
            ryze_token_encrypted: Buffer.from("enc_token"),
          },
          error: null,
        }),
        rpc: vi.fn().mockResolvedValue({ data: "token", error: null }),
      } as any;

      const envelope: OutboundEnvelope = {
        organizationId: "org-100",
        sessionRef: "instancia_a",
        to: "5511999998888",
        kind: "text",
        body: "teste",
        db: fakeDb,
      } as any;

      // 401
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }));
      await expect(ryzeAdapter.send(envelope)).rejects.toThrow("ryze_auth_failed: 401 invalid token");

      // 403
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({}) }));
      await expect(ryzeAdapter.send(envelope)).rejects.toThrow("ryze_permission_denied: 403 instance mismatch");

      // 404
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) }));
      await expect(ryzeAdapter.send(envelope)).rejects.toThrow("ryze_instance_not_found: 404 instance not found");

      // 429
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({}) }));
      await expect(ryzeAdapter.send(envelope)).rejects.toThrow("ryze_rate_limited: 429 rate limit");

      // 500
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }));
      await expect(ryzeAdapter.send(envelope)).rejects.toThrow("ryze_instance_disconnected: HTTP 500");

      // 503
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) }));
      await expect(ryzeAdapter.send(envelope)).rejects.toThrow("ryze_instance_disconnected: HTTP 503");
    });
  });
});
