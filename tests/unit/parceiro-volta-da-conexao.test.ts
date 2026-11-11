import { describe, expect, it, vi } from "vitest";

/**
 * A volta da página de cadastro do provedor parceiro (conexão por um clique).
 *
 * A rota é PÚBLICA (o cookie Strict não vem numa navegação de outro site) e não
 * grava nada: só repassa à tela de Conexões, pela ponte same-origin, o que a
 * volta trouxe — cada valor num formato fixo, porque vai parar numa URL nossa.
 * Quem conclui é a tela autenticada, e o servidor confere estado e conta.
 */
vi.mock("@/lib/branding/saida", () => ({ marcaDaSaida: vi.fn(async () => ({ nome: "Marca" })) }));

import { GET } from "@/app/auth/partner-return/[estado]/route";
import { isPublicPath } from "@/lib/auth/public-paths";

const ESTADO = `${"A".repeat(40)}.${"0".repeat(64)}`;
const CONTA = "b".repeat(24);
const PERFIL = "a".repeat(24);

async function destino(estado: string, query: string): Promise<string> {
  const resposta = await GET(
    new Request(`http://localhost/auth/partner-return/${estado}${query}`),
    {
      params: Promise.resolve({ estado }),
    },
  );
  expect(resposta.status).toBe(200);
  const html = await resposta.text();
  const script = html.match(/<script>(.*?)<\/script>/)?.[1] ?? "";
  return JSON.parse(
    script.replace(/^window\.location\.replace\(/, "").replace(/\);$/, ""),
  ) as string;
}

describe("volta da conexão por um clique", () => {
  it("só o estado no formato exato é público — nenhum sub-path de carona", () => {
    expect(isPublicPath(`/auth/partner-return/${ESTADO}`)).toBe(true);
    expect(isPublicPath(`/auth/partner-return/${ESTADO}/admin`)).toBe(false);
    expect(isPublicPath("/auth/partner-return/qualquer-coisa")).toBe(false);
    expect(isPublicPath("/auth/partner-return")).toBe(false);
  });

  it("conectado: repassa estado, conta e perfil — e nada mais da query", async () => {
    const alvo = await destino(
      ESTADO,
      `?connected=whatsapp&profileId=${PERFIL}&accountId=${CONTA}&username=%2B13105551234&connect_token=SEGREDO`,
    );
    const url = new URL(alvo, "http://localhost");
    expect(url.pathname).toBe("/app/connections");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      aba: "parceiro",
      parceiro_estado: ESTADO,
      parceiro_conta: CONTA,
      parceiro_perfil: PERFIL,
    });
    expect(alvo).not.toContain("SEGREDO");
    expect(alvo).not.toContain("13105551234");
  });

  it("recusa da Meta: repassa o código conhecido, e troca o estranho pelo genérico", async () => {
    expect(
      new URL(
        await destino(ESTADO, "?error=connection_cancelled&platform=whatsapp"),
        "http://x",
      ).searchParams.get("parceiro_erro"),
    ).toBe("connection_cancelled");
    expect(
      new URL(await destino(ESTADO, "?error=%3Cscript%3E"), "http://x").searchParams.get(
        "parceiro_erro",
      ),
    ).toBe("whatsapp_error");
  });

  it.each([
    [
      "estado fora do formato",
      "nao-e-estado",
      `?connected=whatsapp&profileId=${PERFIL}&accountId=${CONTA}`,
    ],
    ["conta fora do formato", ESTADO, `?connected=whatsapp&profileId=${PERFIL}&accountId=../../x`],
    ["sem conta nem erro", ESTADO, "?connected=whatsapp"],
  ])("%s: volta só para a aba, sem repassar nada", async (_nome, estado, query) => {
    expect(await destino(estado, query)).toBe("/app/connections?aba=parceiro");
  });
});
