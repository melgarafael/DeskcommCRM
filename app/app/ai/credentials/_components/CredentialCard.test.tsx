/**
 * `models_available` é `text[]` no banco e chegava tipado como `number` no
 * hook. O card imprimia o array inteiro colado por vírgula ("claude-a,claude-b")
 * onde deveria haver uma contagem.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CredentialCard } from "./CredentialCard";
import type { CredentialRow } from "@/hooks/ai/useCredentials";
import { AO_EXCLUIR_A_CHAVE_DO_JEV } from "@/lib/ai/decisao/textos";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("../_actions", () => ({ refreshCredentialsView: vi.fn() }));

export function credencial(extra: Partial<CredentialRow> = {}): CredentialRow {
  return {
    id: "c1",
    organization_id: "o1",
    provider: "anthropic",
    label: "Produção",
    api_key_last4: "abcd",
    validated_at: "2026-09-02T00:00:00Z",
    validation_error: null,
    models_available: null,
    is_active: true,
    created_by: null,
    created_at: "2026-09-02T00:00:00Z",
    updated_at: "2026-09-02T00:00:00Z",
    ...extra,
  };
}

export function montar(
  row: CredentialRow,
  props: { canWrite?: boolean; usageCount?: number; usadaEm?: string[]; avisoAoExcluir?: string[] } = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CredentialCard
        credential={row}
        canWrite={props.canWrite ?? true}
        usageCount={props.usageCount ?? 0}
        usadaEm={props.usadaEm}
        avisoAoExcluir={props.avisoAoExcluir}
      />
    </QueryClientProvider>,
  );
}

describe("CredentialCard — chave do Jev", () => {
  const AVISO = /Sem ela, o Jev é desligado/;

  it("diz onde a chave trabalha e avisa, antes de excluir, que o Jev será desligado", () => {
    montar(credencial({ provider: "typesafe", label: "Jev" }), {
      usadaEm: ["Medir o clima da conversa"],
      avisoAoExcluir: [AO_EXCLUIR_A_CHAVE_DO_JEV.usada, AO_EXCLUIR_A_CHAVE_DO_JEV.climaComIa],
    });
    expect(screen.getByTestId("credencial-usada-em")).toHaveTextContent(
      "Usada em: Medir o clima da conversa",
    );
    // Não trava como versão de agente: o botão de excluir segue disponível.
    fireEvent.click(screen.getByRole("button", { name: "Excluir credencial" }));
    expect(screen.getByText(AVISO)).toBeInTheDocument();
  });

  it("editar a chave do Jev fala do Jev, não de agentes ligados nela", () => {
    montar(credencial({ provider: "typesafe", label: "Jev" }));
    fireEvent.click(screen.getByRole("button", { name: "Editar credencial" }));
    const dialogo = screen.getByRole("dialog");
    expect(dialogo).toHaveTextContent(/mantém o Jev ligado: na próxima mensagem ele já usa a chave nova/);
    expect(dialogo).not.toHaveTextContent(/agentes ligados/);
    expect(screen.getByRole("link", { name: "Onde pegar a chave" })).toHaveAttribute(
      "href",
      "https://console.typesafe.ai/keys",
    );
  });

  it("chave do Jev recusada: a frase diz que foi a TypeSafe", () => {
    montar(credencial({ provider: "typesafe", validated_at: null, validation_error: "auth_failed_401" }));
    expect(screen.getByText(/^A TypeSafe recusou a chave/)).toBeInTheDocument();
  });

  it("controle: chave que o Jev não usa não tem a linha nem o aviso", () => {
    montar(credencial({ provider: "typesafe", label: "Jev reserva" }));
    expect(screen.queryByTestId("credencial-usada-em")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Excluir credencial" }));
    expect(screen.queryByText(AVISO)).toBeNull();
  });
});

describe("CredentialCard — modelos", () => {
  it("mostra a CONTAGEM de modelos, nunca a lista colada", () => {
    montar(credencial({ models_available: ["claude-a", "claude-b", "claude-c"] }));
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.queryByText(/claude-a,claude-b/)).toBeNull();
  });

  it("mostra travessão quando ainda não há lista", () => {
    montar(credencial({ models_available: null }));
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});

describe("CredentialCard — erro de validação", () => {
  it("401 vira frase e link para pegar chave nova", () => {
    montar(credencial({ validated_at: null, validation_error: "auth_failed_401" }));
    expect(screen.getByText(/recusou a chave/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Onde pegar a chave" })).toHaveAttribute(
      "href",
      "https://console.anthropic.com/settings/keys",
    );
    expect(screen.queryByText("auth_failed_401")).toBeNull();
  });

  it("erro de rede não oferece link: a chave não é o problema", () => {
    montar(credencial({ validated_at: null, validation_error: "network_error" }));
    expect(screen.queryByRole("link", { name: "Onde pegar a chave" })).toBeNull();
  });
});

/**
 * A CHAVE JÁ SALVA TAMBÉM DIZ PARA ONDE O TEXTO VAI (#4519).
 *
 * Quem cadastrou a chave ontem continua sem saber onde o texto é processado; a
 * linha no cartão da credencial é onde ele descobre. E ela aparece nas duas
 * respostas — o provedor que declara país e o que não declara —, porque o
 * silêncio no segundo caso leria como "não sai daqui".
 */
describe("CredentialCard — onde o texto é processado", () => {
  it("provedor com país declarado mostra país, fonte e data", () => {
    montar(credencial({ provider: "deepseek", label: "DeepSeek" }));
    const linha = screen.getByTestId("onde-o-texto-e-processado");
    expect(linha).toHaveAttribute("data-situacao", "declarado");
    expect(linha).toHaveTextContent("China");
    expect(linha).toHaveTextContent("consultada em 12/11/2026");
    expect(screen.getByRole("link", { name: "fonte: política do provedor" })).toHaveAttribute(
      "href",
      "https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html",
    );
  });

  it("provedor sem país declarado mostra o aviso, em vez de esconder a linha", () => {
    montar(credencial({ provider: "anthropic" }));
    const linha = screen.getByTestId("onde-o-texto-e-processado");
    expect(linha).toHaveAttribute("data-situacao", "desconhecido");
    expect(linha).toHaveTextContent("O provedor não declara o país; consulte a política dele");
  });

  it("provedor de voz também responde: a linha não some para quem não conversa", () => {
    montar(credencial({ provider: "elevenlabs", label: "Voz" }));
    expect(screen.getByTestId("onde-o-texto-e-processado")).toHaveAttribute(
      "data-situacao",
      "desconhecido",
    );
  });
});
