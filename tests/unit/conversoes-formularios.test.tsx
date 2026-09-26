import { ScriptDoSite } from "@/app/app/settings/conversoes/_scriptDoSite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FormularioDeCapturaDeUtm } from "@/app/app/settings/conversoes/_formCapturaDeUtm";
import { FormularioDeConversoesGoogle } from "@/app/app/settings/conversoes/_formGoogle";
const mock = vi.hoisted(() => ({ salvarCaptura: vi.fn(), salvarGoogle: vi.fn() }));
vi.mock("@/app/actions/settings/updateCapturaDeUtm", () => ({
  updateCapturaDeUtm: mock.salvarCaptura,
}));
vi.mock("@/app/actions/settings/updateGoogleAdsConnection", () => ({
  updateGoogleAdsConnection: mock.salvarGoogle,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  mock.salvarCaptura.mockResolvedValue({ ok: true });
  mock.salvarGoogle.mockResolvedValue({ ok: true });
});
describe("formulários de conversão", () => {
  it("a captura Google salva destino e referência na plataforma certa", async () => {
    render(
      <FormularioDeCapturaDeUtm
        plataforma="google"
        estado={null}
        idioma="pt-BR"
        slug="loja"
        numerosConectados={[]}
      />,
    );
    fireEvent.change(screen.getByLabelText("Para qual WhatsApp mandar"), {
      target: { value: "+5511999999999" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Salvar endereço de captura" }));
    await waitFor(() =>
      expect(mock.salvarCaptura).toHaveBeenCalledWith(
        expect.objectContaining({
          plataforma: "google_ads",
          whatsapp_e164: "+5511999999999",
          message_template: expect.stringContaining("[ref:{token}]"),
        }),
      ),
    );
    expect(screen.getByText(/O botão do site precisa repassar/)).toBeTruthy();
  });
  it("a regra salva etapa e ação distintas da compra", async () => {
    render(
      <FormularioDeConversoesGoogle
        estado={{
          temRefreshToken: true,
          habilitada: true,
          customerId: "1234567890",
          loginCustomerId: null,
          conversionActionId: "11",
        }}
        idioma="pt-BR"
        configurado
        falta={[]}
        etapas={[{ id: "etapa", nome: "Vendas — Qualificado" }]}
      />,
    );
    fireEvent.change(screen.getByLabelText("Etapa de qualificação"), {
      target: { value: "etapa" },
    });
    fireEvent.change(screen.getByLabelText("Ação de conversão de lead qualificado"), {
      target: { value: "11" },
    });
    expect((screen.getByRole("button", { name: "Salvar" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.change(screen.getByLabelText("Ação de conversão de lead qualificado"), {
      target: { value: "42" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() =>
      expect(mock.salvarGoogle).toHaveBeenCalledWith(
        expect.objectContaining({
          qualification: { stage_id: "etapa", action_id: "42" },
          conversion_action_id: "11",
        }),
      ),
    );
  });
});

it("só gera o script com captura ativa salva, sem credenciais", () => {
  const { rerender } = render(
    <ScriptDoSite slug="loja" google={null} meta={null} idioma="pt-BR" />,
  );
  expect(screen.queryByRole("button", { name: "Copiar script do site" })).toBeNull();
  rerender(
    <ScriptDoSite
      slug="loja"
      google={{
        whatsappE164: "+5511999999999",
        messageTemplate: "Olá [ref:{token}]",
        habilitada: true,
      }}
      meta={null}
      idioma="pt-BR"
    />,
  );
  const code = screen.getByTestId("script-do-site").querySelector("code")!.textContent!;
  expect(code).toContain(window.location.origin + "/rastreio/v1.js");
  expect(code).toContain('data-google-whatsapp="5511999999999"');
  expect(code).not.toContain("data-meta-whatsapp");
  expect(screen.getByRole("button", { name: "Copiar script do site" })).toBeTruthy();
});
