/**
 * O CARTÃO DA CONEXÃO — e o ramo que existia sem nunca ser alcançado.
 *
 * `contaConectada` é declarado nas props desde que o cartão nasceu, e o único
 * call site (`_client.tsx`) NUNCA o passava. Medido: `grep -rn "contaConectada="`
 * devolvia zero. Consequências que se compõem:
 *
 *   1. O ramo `google-conectado` era código morto — nenhum teste o citava.
 *   2. O botão "Conectar Google" NUNCA sumia depois de conectar, então a segunda
 *      conexão era um clique no mesmo botão de sempre. Com `onConflict` por
 *      `(org, user, provider, account_email)`, outra conta = outra linha.
 *
 * Estes casos existem para que o ramo não volte a ser inalcançável: eles testam
 * o PAR (com conta → desconectar e sem "conectar"; sem conta → o inverso), que é
 * o que impede um `true` cravado de passar.
 */
import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CartaoDaConexaoGoogle } from "@/app/app/agenda/_components/CartaoDaConexaoGoogle";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

afterEach(cleanup);

describe("cartão da conexão do Google", () => {
  it("com conta conectada: mostra a conta E oferece desconectar", () => {
    render(<CartaoDaConexaoGoogle configurado falta={[]} contaConectada="ana@clinica.com.br" />);
    expect(screen.getByTestId("google-conectado")).toBeTruthy();
    expect(screen.getByText("ana@clinica.com.br")).toBeTruthy();
    expect(
      screen.getByTestId("desconectar-google"),
      "conectar sem poder desconectar deixa o refresh token da conta pessoal no " +
        "banco sem via de produto que o apague",
    ).toBeTruthy();
  });

  it("...e o botão de CONECTAR some — senão a segunda conexão é um clique", () => {
    render(<CartaoDaConexaoGoogle configurado falta={[]} contaConectada="ana@clinica.com.br" />);
    expect(screen.queryByTestId("conectar-google")).toBeNull();
  });

  it("sem conta: oferece conectar e NÃO oferece desconectar", () => {
    // O outro lado do par. Sem ele, um `contaConectada` cravado como verdadeiro
    // passaria nos dois casos acima e ninguém veria.
    render(<CartaoDaConexaoGoogle configurado falta={[]} contaConectada={null} />);
    expect(screen.getByTestId("conectar-google")).toBeTruthy();
    expect(screen.queryByTestId("desconectar-google")).toBeNull();
    expect(screen.queryByTestId("google-conectado")).toBeNull();
  });

  it("...e esse botão aponta para a rota de ida — o fio que nenhum teste segurava", () => {
    // REDE DE REGRESSÃO, não motor de conserto: este caso JÁ passava antes da
    // mudança, e está escrito aqui por isso.
    //
    // Um caso Playwright que clicasse o botão e conferisse `accounts.google.com`
    // + `prompt=consent select_account` + `login_hint` repetiria o que já está
    // medido: esse destino é asseverado — sobre o header `Location` de
    // verdade — em tests/unit/agenda-google-connect-route.test.ts:67-80. O
    // único elo da corrente que ninguém segurava era este: que o botão da tela
    // aponta para a rota que produz aquele destino. É um `<a href>`, então um
    // caso de unidade o prende inteiro, roda no CI e não depende de credencial
    // do Google — que a spec e2e não tem, e sem a qual ela pularia.
    render(<CartaoDaConexaoGoogle configurado falta={[]} contaConectada={null} />);
    expect(screen.getByTestId("conectar-google").getAttribute("href")).toBe(
      "/api/v1/agenda/google/connect",
    );
  });

  it("sem credenciais: diz o ENDEREÇO DE RETORNO a registrar, e dá para copiar", () => {
    // ⚠️ ESTE CASO NASCEU DE UM TROPEÇO REAL. Recebi uma credencial do Google
    // criada no console com `http://localhost:3012` registrado — e o produto
    // monta `http://localhost:3012/api/v1/agenda/google/callback`. O Google
    // compara BYTE A BYTE e recusa com `redirect_uri_mismatch`, um erro que
    // aponta para o Google e não para a divergência.
    //
    // Nada no produto dizia qual endereço registrar: nem tela, nem `.env.example`,
    // nem runbook. Quem cria a credencial registra o endereço do APP, que é o
    // palpite natural e está errado.
    render(
      <CartaoDaConexaoGoogle
        configurado={false}
        falta={["GOOGLE_CALENDAR_CLIENT_ID"]}
        enderecoDeRetorno="https://crm.exemplo/api/v1/agenda/google/callback"
      />,
    );
    const alvo = screen.getByTestId("endereco-de-retorno");
    expect(
      alvo.textContent,
      "a tela precisa dizer o endereço COMPLETO, com o caminho do callback — " +
        "só a origem é o palpite que o Google recusa",
    ).toBe("https://crm.exemplo/api/v1/agenda/google/callback");
    expect(
      alvo.className,
      "sem `select-all` a pessoa copia com o mouse e leva espaço junto",
    ).toContain("select-all");
  });

  it("...e não mostra endereço nenhum quando a instalação JÁ está configurada", () => {
    // O par: um bloco que aparece sempre viraria ruído na tela de quem já
    // resolveu, e ruído compete com o que importa (invariante 5 do Sistema Vivo).
    render(
      <CartaoDaConexaoGoogle
        configurado
        falta={[]}
        contaConectada="ana@clinica.com.br"
        enderecoDeRetorno="https://crm.exemplo/api/v1/agenda/google/callback"
      />,
    );
    expect(screen.queryByTestId("endereco-de-retorno")).toBeNull();
  });

  it("sem as credenciais da instalação: nenhum dos dois, e diz o que falta", () => {
    render(
      <CartaoDaConexaoGoogle
        configurado={false}
        falta={["GOOGLE_CALENDAR_CLIENT_ID"]}
        contaConectada="ana@clinica.com.br"
      />,
    );
    // A ordem dos ramos importa: quem não configurou a instalação não pode ver
    // "desconectar" só porque há linha no banco.
    expect(screen.getByTestId("google-nao-configurado")).toBeTruthy();
    expect(screen.getByTestId("o-que-falta").textContent).toContain("GOOGLE_CALENDAR_CLIENT_ID");
    expect(screen.queryByTestId("desconectar-google")).toBeNull();
  });
});
