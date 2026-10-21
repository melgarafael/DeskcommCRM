import { describe, expect, it, vi } from "vitest";

import type * as Instalacao from "@/lib/branding/instalacao";

/**
 * O iPhone não lê o manifest para o ícone nem para o nome da tela de início:
 * lê `apple-touch-icon` e `apple-mobile-web-app-title`. Sem o título, ele usa
 * o `<title>` longo da página.
 */
vi.mock("next/font/local", () => ({ default: () => ({ variable: "" }) }));
vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("@/lib/branding/instalacao", async (original) => ({
  ...(await original<typeof Instalacao>()),
  marcaDaInstalacao: vi.fn().mockResolvedValue({ app_name: "Central", favicon_path: "platform/x.png" }),
}));

import { generateMetadata } from "@/app/layout";

describe("metadata do app no iPhone", () => {
  it("declara o ícone de 180 com o mesmo sufixo do manifest e o nome curto da instalação", async () => {
    const meta = await generateMetadata();
    expect(meta.icons).toMatchObject({ apple: "/app-icon/180?v=platform%2Fx.png" });
    expect(meta.appleWebApp).toMatchObject({ capable: true, title: meta.applicationName });
  });
});
