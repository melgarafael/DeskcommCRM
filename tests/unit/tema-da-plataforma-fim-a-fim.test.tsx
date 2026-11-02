import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TemaDeExtensao } from "@/lib/extensions/tema";

const mocks = vi.hoisted(() => ({
  admin: vi.fn(),
  valorDaInstalacao: vi.fn(),
}));

vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Headers()) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.admin }));
vi.mock("@/lib/instalacao/config", () => ({
  valorDaInstalacao: mocks.valorDaInstalacao,
  gravarPelaTela: vi.fn(),
  voltarAoAmbiente: vi.fn(),
}));

import { EstiloDoTemaDaPlataforma } from "@/app/tema-da-plataforma";
import { invalidarTemaDaPlataforma } from "@/lib/extensions/tema-da-plataforma";

/**
 * FIM A FIM NA BORDA DO LAYOUT (#3790): da linha em `platform_config` até o
 * `<style>` que o `<html>` de `/admin` (e do login) recebe.
 *
 * ── Por que este arquivo, se há três vizinhos ─────────────────────────────
 *
 * O construtor tem teste próprio (escopo e chaves), a leitura tem o dela (banco
 * → texto) e o componente tem o dele (com CSS, emite o nó). Nenhum deles prova
 * que as TRÊS peças estão ligadas: aqui só se dubla o banco, e o caminho
 * inteiro — `platform_config` → instalação → manifesto → `:root:root` →
 * `<style id="tema-da-plataforma">` — roda de verdade.
 *
 * É a asserção que o defeito da issue pedia: hoje (main) o `<style>` não existe
 * em tela nenhuma fora do `/app` de quem escolheu. E o outro lado, que a issue
 * exige na mesma frase: sem escolha, NÃO existe — nada muda para quem não usa.
 */

const INSTALACAO = {
  id: "11111111-1111-4111-8111-111111111111",
  publisher: "acme",
  name: "tema-do-cliente",
  version: "1.2.0",
  removed_at: null,
  extension_artifacts: {
    manifest: {
      contributions: {
        theme: {
          palette: "mist",
          claro: {
            "--color-bg": "#f6f6f4",
            "--color-border": "#e7e3da",
            "--color-accent": "var(--color-accent-600)",
            "--color-accent-600": "#33475b",
          },
          escuro: {
            "--color-bg": "#11151c",
            "--color-border": "#2a2f38",
            "--color-accent": "var(--color-accent-400)",
            "--color-accent-400": "#8fa8be",
          },
        } satisfies TemaDeExtensao,
      },
    },
  },
};

function clienteFalso(resultado: () => { data: unknown; error: unknown }) {
  const construtor = {
    select: () => construtor,
    eq: () => construtor,
    is: () => construtor,
    order: () => construtor,
    limit: () => construtor,
    maybeSingle: async () => resultado(),
    then: (ok: (v: { data: unknown; error: unknown }) => unknown) =>
      Promise.resolve(resultado()).then(ok),
  };
  return { from: () => construtor };
}

async function documentoDoLayout() {
  return renderToStaticMarkup(
    <html lang="pt-BR" data-theme="light">
      {/* eslint-disable-next-line @next/next/no-head-element -- o documento do teste É
          o `<html>` do layout raiz; não é página do Next, e sim o SSR que ele faz. */}
      <head>{await EstiloDoTemaDaPlataforma()}</head>
      <body />
    </html>,
  );
}

describe("tema da plataforma — da gravação ao `<style>` do documento", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // O memo de PROCESSO sobrevive ao teste: sem esta invalidação o caso "sem
    // escolha" leria o CSS do caso anterior e a asserção de ausência mentiria.
    invalidarTemaDaPlataforma();
    mocks.valorDaInstalacao.mockResolvedValue({ valor: null, fonte: "env" });
    mocks.admin.mockReturnValue(clienteFalso(() => ({ data: null, error: null })));
  });

  it("com a escolha gravada, o documento recebe o bloco em `:root:root` e sem accent", async () => {
    mocks.valorDaInstalacao.mockResolvedValue({ valor: INSTALACAO.id, fonte: "banco" });
    mocks.admin.mockReturnValue(clienteFalso(() => ({ data: INSTALACAO, error: null })));

    const html = await documentoDoLayout();

    expect(html).toContain('<style id="tema-da-plataforma">');
    expect(html).toContain(":root:root {");
    expect(html).toContain(':root:root[data-theme="dark"] {');
    expect(html).toContain("--color-bg: #f6f6f4");
    // A cor de ação continua vindo da tela Marca: nenhuma chave de accent aqui.
    expect(html).not.toContain("--color-accent");
    // E o seletor da organização não aparece no bloco da instalação.
    expect(html).not.toContain("body:has");
  });

  it("sem escolha gravada, o documento NÃO ganha `<style>` nenhum", async () => {
    const html = await documentoDoLayout();

    expect(html).not.toContain("<style");
    expect(html).not.toContain("--color-bg");
  });

  it("escolha que envelheceu (instalação sumiu) também não pinta nada", async () => {
    mocks.valorDaInstalacao.mockResolvedValue({ valor: INSTALACAO.id, fonte: "banco" });
    mocks.admin.mockReturnValue(clienteFalso(() => ({ data: null, error: null })));

    expect(await documentoDoLayout()).not.toContain("<style");
  });
});
