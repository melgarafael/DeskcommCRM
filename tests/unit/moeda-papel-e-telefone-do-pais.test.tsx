/**
 * O que a tela diz depende da MOEDA e do PAÍS da organização, e não do Brasil escrito à mão.
 *
 *   1. o campo personalizado de moeda (o tipo que se chamava « Moeda (BRL) » em toda organização) escreve, lê e se
 *      chama pela moeda da organização (`organizations.currency`);
 *   2. o convite de equipe diz o papel pelo nome (« Atendente »), não pelo código (« agent »);
 *   3. o exemplo dos campos de telefone é o do país da organização (`perfil.telefoneExemplo`).
 *
 * A organização de fora do Brasil é a portuguesa (EUR, PT), um país que o perfil já serve. O português que já existia
 * não muda onde a tela já estava certa: os casos em real comparam com a saída de ANTES (o `Intl` pt-BR), não com uma
 * constante nova.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  org: { currency: "EUR", country: "PT" } as { currency: string | null; country: string | null } | null,
}));

vi.mock(import("@/hooks/auth/AuthProvider"), async (original) => ({
  ...(await original()),
  // Só a moeda e o país interessam aqui; o resto da organização ativa não é lido por estas telas.
  useActiveOrg: () => h.org as unknown as ActiveOrg | null,
  useMoedaDaOrgAtiva: () => h.org?.currency ?? null,
  usePaisDaOrgAtiva: () => h.org?.country ?? null,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/app/actions/settings/updatePipelineConfig", () => ({ updatePipelineConfig: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/app/app/settings/tenant/pipelines/_stages", () => ({ StagesSection: () => null, ancoraDasEtapas: () => "etapas" }));
vi.mock("@/app/app/settings/tenant/pipelines/_mapping", () => ({
  AgentMappingSection: () => null,
  ancoraDoMapeamento: () => "mapeamento",
}));

import { PipelinesClient, type PipelineRow } from "@/app/app/settings/tenant/pipelines/_client";
import { CadastrarCampo } from "@/app/app/webhooks/_components/CadastrarCampo";
import { PairingOptions } from "@/components/connections/PairingOptions";
import { CustomFieldsEditor } from "@/components/contacts/CustomFieldsEditor";
import { CamposObrigatoriosDialog } from "@/components/kanban/CamposObrigatoriosDialog";
import { useTelefoneExemplo } from "@/hooks/contacts/useTelefoneExemplo";
import { buildInviteEmail } from "@/lib/email/templates/invite";
import { exemploDoCampoDeMoeda, lerCampoDeMoeda, semAMoeda, valorDoCampoDeMoeda } from "@/lib/leads/campo-de-moeda";
import type { ActiveOrg } from "@/lib/auth/types";

beforeAll(() => {
  // Radix Select usa pointer capture e scrollIntoView; o jsdom não tem nenhum dos dois.
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

beforeEach(() => {
  h.org = { currency: "EUR", country: "PT" };
});

/** O espaço do `Intl` (fino, inseparável) vira espaço comum — a comparação é do texto, não do caractere. */
const plano = (s: string | null | undefined) => (s ?? "").replace(/[  ]/g, " ");

// ─── 1. O campo de moeda ─────────────────────────────────────────────────────────────────────────────

describe("1. o campo de moeda segue a moeda da organização", () => {
  it("em real, o valor e o exemplo saem exatamente como antes (o `Intl` pt-BR)", () => {
    const antes = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
    expect(valorDoCampoDeMoeda(1250.5, "BRL")).toBe(antes.format(1250.5));
    expect(exemploDoCampoDeMoeda("BRL")).toBe(antes.format(0));
    expect(lerCampoDeMoeda("R$ 1.250,50", "BRL")).toBe(125050);
    expect(lerCampoDeMoeda("r$1250,5", "BRL")).toBe(125050);
  });

  /**
   * ⚠️ O CAMPO PERSONALIZADO DE MOEDA É ONDE O DEFEITO FOI MEDIDO (#3331).
   *
   * Numa organização em dólar, digitar `1,300` neste campo gravava `1,3`: o
   * parser lia a vírgula como decimal (regra do pt-BR) porque não sabia a
   * moeda — apesar de `lerCampoDeMoeda` JÁ receber a moeda da organização e
   * usá-la para formatar o exemplo e tirar o símbolo. A moeda chegava até a
   * porta e parava ali; agora ela atravessa (`semAMoeda` → `parseReaisToCents`).
   */
  it("⭐ em dólar, `$1,300.00` são mil e trezentos e `$1.30` é um e trinta", () => {
    expect(lerCampoDeMoeda("$1,300.00", "USD")).toBe(130000);
    expect(lerCampoDeMoeda("1,300", "USD")).toBe(130000);
    expect(lerCampoDeMoeda("$1.30", "USD")).toBe(130);
  });

  it("em euro, escreve o valor em euro e lê o que se digita, com ou sem o símbolo", () => {
    expect(plano(valorDoCampoDeMoeda(1250.5, "EUR"))).toContain("€");
    expect(plano(valorDoCampoDeMoeda(1250.5, "EUR"))).not.toContain("R$");
    expect(lerCampoDeMoeda("1 300,25 €", "EUR")).toBe(130025);
    expect(lerCampoDeMoeda("EUR 12", "EUR")).toBe(1200);
    expect(lerCampoDeMoeda("12abc", "EUR")).toBeNull();
    expect(semAMoeda(" € ", "EUR")).toBe("");
  });

  it("no editor de campos, numa organização em euro: exemplo, valor e leitura em euro", () => {
    const mudancas: Array<Record<string, unknown>> = [];
    const campos = [{ key: "orcamento", label: "Orçamento", type: "currency" as const }];
    const { rerender } = render(<CustomFieldsEditor fields={campos} value={{}} onChange={(v) => mudancas.push(v)} mode="lead" />);
    const campo = screen.getByLabelText("Orçamento") as HTMLInputElement;
    expect(plano(campo.placeholder)).toBe(plano(exemploDoCampoDeMoeda("EUR")));
    expect(campo.placeholder).not.toContain("R$");

    fireEvent.change(campo, { target: { value: "1 300,25 €" } });
    fireEvent.blur(campo);
    expect(mudancas.at(-1)).toEqual({ orcamento: 1300.25 });

    rerender(<CustomFieldsEditor fields={campos} value={{ orcamento: 1250.5 }} onChange={(v) => mudancas.push(v)} mode="lead" />);
    expect(plano((screen.getByLabelText("Orçamento") as HTMLInputElement).value)).toBe(plano(valorDoCampoDeMoeda(1250.5, "EUR")));
  });

  it("no editor, só o símbolo apaga o campo, e texto que não é número não grava nada", () => {
    const mudancas: Array<Record<string, unknown>> = [];
    const campos = [{ key: "orcamento", label: "Orçamento", type: "currency" as const }];
    render(<CustomFieldsEditor fields={campos} value={{ orcamento: 10 }} onChange={(v) => mudancas.push(v)} mode="lead" />);
    const campo = screen.getByLabelText("Orçamento");
    fireEvent.change(campo, { target: { value: "abc" } });
    fireEvent.blur(campo);
    expect(mudancas).toEqual([]);
    fireEvent.change(campo, { target: { value: "€" } });
    fireEvent.blur(campo);
    expect(mudancas.at(-1)).toEqual({ orcamento: null });
  });

  it("no diálogo dos campos obrigatórios, em euro: o exemplo e o valor que vai para o funil", () => {
    const confirmados: Array<{ customFields: Record<string, unknown> }> = [];
    render(
      <CamposObrigatoriosDialog
        open
        onOpenChange={() => {}}
        recusa={{ args: {} as never, faltando: [{ chave: "orcamento", rotulo: "Orçamento", tipo: "currency" }] }}
        onConfirmar={(v) => confirmados.push(v)}
      />,
    );
    const exemplo = plano(exemploDoCampoDeMoeda("EUR", 1250));
    const campo = screen.getByPlaceholderText((_, el) => plano(el?.getAttribute("placeholder")) === exemplo);
    fireEvent.change(campo, { target: { value: "1 300,25 €" } });
    fireEvent.click(screen.getByRole("button", { name: "Mover agora" }));
    expect(confirmados).toEqual([{ customFields: { orcamento: 1300.25 } }]);
  });

  it("nas Configurações › Funis, o tipo diz a moeda da organização — e em real, o « Moeda (BRL) » de antes", () => {
    const funil = {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Vendas",
      slug: "vendas",
      vocabulary: {},
      settings: { fields: [{ key: "orcamento", label: "Orçamento", type: "currency" }] },
    } as unknown as PipelineRow;
    // O editor do funil monta sob demanda (#3176): abre-se pelo botão, como quem configura.
    const abrirEditor = () =>
      fireEvent.click(screen.getByRole("button", { name: "Editar vocabulário e campos deste funil" }));
    const { unmount } = render(<PipelinesClient pipelines={[funil]} podeEditarConfig />);
    abrirEditor();
    expect(screen.getAllByText("Moeda (EUR)").length).toBeGreaterThan(0);
    expect(screen.queryByText(/BRL/)).toBeNull();
    unmount();

    h.org = { currency: "BRL", country: null };
    render(<PipelinesClient pipelines={[funil]} podeEditarConfig />);
    abrirEditor();
    expect(screen.getAllByText("Moeda (BRL)").length).toBeGreaterThan(0);
  });

  it("ao cadastrar um campo vindo da captação, o tipo moeda é o da organização", () => {
    render(<CadastrarCampo chave="orcamento" valor={1250} tipoInicial="currency" cadastrar={async () => true} />);
    fireEvent.click(screen.getByRole("button", { name: "Cadastrar como campo do lead" }));
    expect(screen.getAllByText("Moeda (EUR)").length).toBeGreaterThan(0);
    expect(screen.queryByText("Moeda (BRL)")).toBeNull();
  });
});

// ─── 2. O papel no convite ───────────────────────────────────────────────────────────────────────────

describe("2. o convite de equipe diz o papel pelo nome", () => {
  const MARCA = { nome: "Vendas Turbo", logoUrl: null, accent: "#2f6f4e", accentFg: "#ffffff", origens: { nome: "banco", cor: "banco" } } as const;

  it("« Atendente », não « agent » — no HTML e no texto", () => {
    const { html, text } = buildInviteEmail({
      inviterName: "Ana",
      orgName: "Clínica Bem Viver",
      acceptUrl: "https://x/y",
      role: "agent",
      expiresAt: new Date("2026-10-28T12:00:00.000Z"),
      marca: MARCA,
    });
    expect(html).toContain("<strong>Atendente</strong>");
    expect(html).not.toContain(">agent<");
    expect(text.split("\n")[0]).toBe("Você foi convidado para a Clínica Bem Viver como Atendente no Vendas Turbo.");
  });

  it("papel desconhecido continua aparecendo pelo código: nunca some", () => {
    const { html } = buildInviteEmail({
      inviterName: "Ana",
      orgName: "Clínica Bem Viver",
      acceptUrl: "https://x/y",
      role: "papel-novo",
      expiresAt: new Date("2026-10-28T12:00:00.000Z"),
      marca: MARCA,
    });
    expect(html).toContain("<strong>papel-novo</strong>");
  });
});

// ─── 3. O telefone de exemplo ────────────────────────────────────────────────────────────────────────

function Exemplo() {
  return <span data-testid="exemplo">{useTelefoneExemplo()}</span>;
}

describe("3. o exemplo de telefone é do país da organização", () => {
  it("Portugal, e o Brasil quando a organização não diz o país", () => {
    const { unmount } = render(<Exemplo />);
    expect(screen.getByTestId("exemplo").textContent).toBe("+351912345678");
    unmount();
    h.org = { currency: "BRL", country: null };
    render(<Exemplo />);
    expect(screen.getByTestId("exemplo").textContent).toBe("+5511999998888");
  });

  it("o pareamento por código usa o exemplo que a página entrega — o onboarding, que não tem o provider", () => {
    h.org = null;
    render(<PairingOptions sessionId="s1" qr={null} telefoneExemplo="+351912345678" />);
    fireEvent.click(screen.getByRole("button", { name: "Conectar por código" }));
    expect(screen.getByRole("textbox").getAttribute("placeholder")).toBe("+351912345678");
  });

  it("nenhuma tela escreve um telefone de exemplo em duro", () => {
    const RAIZ = join(__dirname, "..", "..");
    // Cada exceção com o motivo. SÓ ENCOLHE.
    const EXCECOES: Record<string, string> = {
      "components/connections/TemplatesParceiroClient.tsx":
        "« +595… » no botão de telefone dos modelos do parceiro do Paraguai: o parceiro opera lá, o número do botão é dele",
    };
    const achados: string[] = [];
    const visita = (dir: string) => {
      for (const nome of readdirSync(dir)) {
        if (nome === "node_modules" || nome.startsWith(".")) continue;
        const caminho = join(dir, nome);
        if (statSync(caminho).isDirectory()) visita(caminho);
        else if (/\.tsx$/.test(nome) && !/\.test\.tsx$/.test(nome)) {
          const rel = relative(RAIZ, caminho).split(sep).join("/");
          if (EXCECOES[rel]) continue;
          readFileSync(caminho, "utf8")
            .split("\n")
            .forEach((linha, i) => {
              // Telefone = « + » e dígito (E.164, com ou sem espaço), ou a forma brasileira sem o « + » (55 e oito ou
              // mais dígitos). Porta (« 587 »), código de verificação (« 000000 ») e identificador de conta
              // (« 123-456-7890 ») ficam de fora.
              const telefone = /placeholder=\{?["'`]\+\d/.test(linha) || /placeholder=\{?["'`]55\d{8,}/.test(linha);
              if (telefone) achados.push(`${rel}:${i + 1} → ${linha.trim().slice(0, 80)}`);
            });
        }
      }
    };
    for (const area of ["app", "components"]) visita(join(RAIZ, area));
    expect(achados, "telefone de exemplo em duro: use `useTelefoneExemplo()` (ou o `perfil.telefoneExemplo`)").toEqual([]);
  });
});
