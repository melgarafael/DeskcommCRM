/**
 * O CARTÃO DO GOOGLE ADS SEM AS CREDENCIAIS DA INSTALAÇÃO.
 *
 * `googleAdsEstaConfigurado` e `faltaParaConectarOGoogleAds` entraram na main
 * (#1165) sem nenhum chamador — medido: `git grep` fora de `config.ts` vazio.
 * O cartão mostrava "Conectar com Google" numa instalação sem as três
 * variáveis, e o clique terminava em `google_ads_nao_configurado`; o
 * fragmento de release prometia o contrário ("o botão não aparece").
 *
 * Os casos testam o PAR (sem credencial → sem botão E com o que falta; com
 * credencial → o botão), e o último amarra a PÁGINA às duas funções: um
 * `configurado` cravado em `true` no call site passaria nos dois primeiros.
 */
import fs from "node:fs";
import path from "node:path";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FormularioDeConversoesGoogle } from "@/app/app/settings/conversoes/_formGoogle";
import type { EstadoDaConexaoGoogle } from "@/lib/plataformas-de-anuncio/google/estado-da-conexao";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/actions/settings/updateGoogleAdsConnection", () => ({
  updateGoogleAdsConnection: vi.fn(),
}));

afterEach(cleanup);

const SEM_CONEXAO: EstadoDaConexaoGoogle = {
  temRefreshToken: false,
  habilitada: false,
  customerId: null,
  loginCustomerId: null,
  conversionActionId: null,
};

const LINK_DE_CONECTAR = /\/api\/v1\/plataformas-de-anuncio\/google\/connect/;

function linksDeConectar(container: HTMLElement): Element[] {
  return Array.from(container.querySelectorAll("a")).filter((a) =>
    LINK_DE_CONECTAR.test(a.getAttribute("href") ?? ""),
  );
}

describe("cartão do Google Ads", () => {
  it("sem as credenciais: nenhum link de conectar, e diz o que falta pelo nome", () => {
    const { container } = render(
      <FormularioDeConversoesGoogle
        estado={SEM_CONEXAO}
        idioma="pt-BR"
        configurado={false}
        falta={["GOOGLE_ADS_DEVELOPER_TOKEN", "GOOGLE_ADS_OAUTH_CLIENT_SECRET"]}
      />,
    );
    expect(linksDeConectar(container)).toHaveLength(0);
    expect(screen.getByTestId("google-ads-nao-configurado")).toBeTruthy();
    const falta = screen.getByTestId("google-ads-o-que-falta").textContent ?? "";
    expect(falta).toContain("GOOGLE_ADS_DEVELOPER_TOKEN");
    expect(falta).toContain("GOOGLE_ADS_OAUTH_CLIENT_SECRET");
  });

  it("sem as credenciais e JÁ conectada antes: nem o formulário nem o reconectar aparecem", () => {
    const { container } = render(
      <FormularioDeConversoesGoogle
        estado={{ ...SEM_CONEXAO, temRefreshToken: true, customerId: "1234567890" }}
        idioma="pt-BR"
        configurado={false}
        falta={["GOOGLE_ADS_DEVELOPER_TOKEN"]}
      />,
    );
    expect(linksDeConectar(container)).toHaveLength(0);
    expect(container.querySelector("form")).toBeNull();
  });

  it("com as credenciais: o botão de conectar aparece", () => {
    const { container } = render(
      <FormularioDeConversoesGoogle estado={SEM_CONEXAO} idioma="pt-BR" configurado falta={[]} />,
    );
    expect(linksDeConectar(container)).toHaveLength(1);
    expect(screen.queryByTestId("google-ads-nao-configurado")).toBeNull();
  });

  it("a página passa as duas funções da config — não um valor cravado", () => {
    const fonte = fs.readFileSync(
      path.join(__dirname, "..", "..", "app", "app", "settings", "conversoes", "page.tsx"),
      "utf8",
    );
    expect(fonte).toMatch(/configurado=\{googleAdsEstaConfigurado\(estadoGoogle.api\)\}/);
    expect(fonte).toMatch(/falta=\{faltaParaConectarOGoogleAds\(estadoGoogle.api\)\}/);
  });
});
