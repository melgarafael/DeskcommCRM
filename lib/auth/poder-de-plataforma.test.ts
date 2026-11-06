import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ user: null as unknown, org: null as unknown }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: async () => m.user,
  orgAtivaSemPortao: async () => m.org,
}));

import { agindoPeloPoderDePlataforma } from "./poder-de-plataforma";

const PA = { is_platform_admin: true, support: null };

beforeEach(() => {
  m.user = null;
  m.org = null;
});

describe("agindoPeloPoderDePlataforma — quando dispositivo confiável não basta", () => {
  it("platform admin que NÃO é admin da org ativa: é o poder de plataforma que o autoriza", async () => {
    for (const role of ["viewer", "agent", "manager"]) {
      m.user = PA;
      m.org = { role };
      expect(await agindoPeloPoderDePlataforma(), role).toBe(true);
    }
  });

  it("platform admin sem organização ativa: também", async () => {
    m.user = PA;
    expect(await agindoPeloPoderDePlataforma()).toBe(true);
  });

  it("o dono da instalação, admin da própria empresa: não", async () => {
    m.user = PA;
    m.org = { role: "admin" };
    expect(await agindoPeloPoderDePlataforma()).toBe(false);
  });

  it("quem não é platform admin, ou está em sessão de suporte: não", async () => {
    m.user = { is_platform_admin: false, support: null };
    m.org = { role: "viewer" };
    expect(await agindoPeloPoderDePlataforma()).toBe(false);
    m.user = { is_platform_admin: true, support: { status: "active" } };
    expect(await agindoPeloPoderDePlataforma()).toBe(false);
  });
});
