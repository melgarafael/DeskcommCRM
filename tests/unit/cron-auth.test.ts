import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { timingSafeStringEqual, autorizaCron } from "@/lib/auth/cron-auth";
import { env } from "@/lib/env";

describe("cron-auth", () => {
  describe("timingSafeStringEqual", () => {
    it("retorna true para strings idênticas", () => {
      expect(timingSafeStringEqual("segredo_ultra_secreto_123", "segredo_ultra_secreto_123")).toBe(true);
    });

    it("retorna false para strings diferentes com mesmo tamanho", () => {
      expect(timingSafeStringEqual("segredo_1", "segredo_2")).toBe(false);
    });

    it("retorna false para strings com tamanhos diferentes sem estourar exceção", () => {
      expect(timingSafeStringEqual("curto", "longo_com_muitos_caracteres")).toBe(false);
    });

    it("retorna false quando qualquer uma for vazia", () => {
      expect(timingSafeStringEqual("", "algo")).toBe(false);
      expect(timingSafeStringEqual("algo", "")).toBe(false);
      expect(timingSafeStringEqual("", "")).toBe(false);
    });
  });

  describe("autorizaCron", () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it("rejeita requisição sem cabeçalhos de autorização", () => {
      const req = new NextRequest("http://localhost/api/v1/cron/data-retention");
      expect(autorizaCron(req)).toBe(false);
    });

    it("rejeita requisição com Bearer incorreto", () => {
      const req = new NextRequest("http://localhost/api/v1/cron/data-retention", {
        headers: {
          authorization: "Bearer token_invalido_total",
        },
      });
      expect(autorizaCron(req)).toBe(false);
    });

    it("rejeita requisição com x-cron-secret incorreto", () => {
      const req = new NextRequest("http://localhost/api/v1/cron/routing-worker", {
        headers: {
          "x-cron-secret": "segredo_errado",
        },
      });
      expect(autorizaCron(req)).toBe(false);
    });

    it("aceita requisição com Bearer igual a INTERNAL_CRON_SECRET", () => {
      // Garantir valor de teste no env
      const original = env.INTERNAL_CRON_SECRET;
      try {
        (env as { INTERNAL_CRON_SECRET?: string }).INTERNAL_CRON_SECRET = "segredo_cron_teste_123";
        const req = new NextRequest("http://localhost/api/v1/cron/data-retention", {
          headers: {
            authorization: "Bearer segredo_cron_teste_123",
          },
        });
        expect(autorizaCron(req)).toBe(true);
      } finally {
        (env as { INTERNAL_CRON_SECRET?: string }).INTERNAL_CRON_SECRET = original;
      }
    });

    it("aceita requisição com x-cron-secret igual a INTERNAL_SECRET", () => {
      const original = env.INTERNAL_SECRET;
      try {
        (env as { INTERNAL_SECRET?: string }).INTERNAL_SECRET = "segredo_interno_teste_456";
        const req = new NextRequest("http://localhost/api/v1/cron/routing-worker", {
          headers: {
            "x-cron-secret": "segredo_interno_teste_456",
          },
        });
        expect(autorizaCron(req)).toBe(true);
      } finally {
        (env as { INTERNAL_SECRET?: string }).INTERNAL_SECRET = original;
      }
    });

    it("opera fail-closed se ambos os segredos estiverem vazios no ambiente", () => {
      const origCron = env.INTERNAL_CRON_SECRET;
      const origInternal = env.INTERNAL_SECRET;
      try {
        (env as { INTERNAL_CRON_SECRET?: string }).INTERNAL_CRON_SECRET = "";
        (env as { INTERNAL_SECRET?: string }).INTERNAL_SECRET = "";

        const req = new NextRequest("http://localhost/api/v1/cron/data-retention", {
          headers: {
            authorization: "Bearer qualquer_coisa",
            "x-cron-secret": "qualquer_coisa",
          },
        });
        expect(autorizaCron(req)).toBe(false);
      } finally {
        (env as { INTERNAL_CRON_SECRET?: string }).INTERNAL_CRON_SECRET = origCron;
        (env as { INTERNAL_SECRET?: string }).INTERNAL_SECRET = origInternal;
      }
    });
  });
});
