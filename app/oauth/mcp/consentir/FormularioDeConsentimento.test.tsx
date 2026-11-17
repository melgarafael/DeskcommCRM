/**
 * `mcp:write` libera ferramentas que ENVIAM ao cliente da empresa
 * (`crm_send_whatsapp_message`, `crm_send_material`). A tela de consentimento
 * tem de dizer isso quando oferece escrita — e não dizer quando não oferece.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/i18n/IdiomaProvider", () => ({ useT: () => (texto: string) => texto }));

import { TEXTOS_MCP_OAUTH } from "@/lib/i18n/mcp-oauth";

import { FormularioDeConsentimento } from "./FormularioDeConsentimento";

const AVISO = "E enviar mensagens de WhatsApp e materiais diretamente aos seus clientes, em nome da empresa.";

function tela(escritaOferecida: boolean): string {
  return renderToStaticMarkup(
    <FormularioDeConsentimento
      pedido={{
        response_type: "code",
        client_id: `dcc_${"a".repeat(32)}`,
        redirect_uri: "https://chatgpt.com/cb",
        code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        code_challenge_method: "S256",
      }}
      nomeDoAplicativo="ChatGPT"
      hostDeVolta="chatgpt.com"
      organizacoes={[{ id: "o1", nome: "Loja" }]}
      escritaOferecida={escritaOferecida}
      email="admin@loja.test"
    />,
  );
}

describe("consentimento: o que 'Ler e alterar' permite", () => {
  it("com escrita oferecida, diz que o aplicativo poderá enviar mensagens e materiais aos clientes", () => {
    expect(tela(true)).toContain(AVISO);
  });

  it("só leitura não fala de envio", () => {
    expect(tela(false)).not.toContain("enviar mensagens");
  });

  it("o aviso tem tradução", () => {
    expect(TEXTOS_MCP_OAUTH[AVISO].es).toContain("enviar mensajes de WhatsApp");
  });
});
