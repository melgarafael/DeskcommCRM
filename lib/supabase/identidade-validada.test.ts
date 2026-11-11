// @vitest-environment node
/**
 * O cache curto da IDENTIDADE no proxy (#4326 item 1) — casos de borda que o
 * teste do proxy inteiro não isola: o que se guarda, o que não se guarda, o teto
 * no `exp` e a chave COMPARTILHADA com o handler do #3696.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  TTL_CURTO_MS,
  comCacheCurto,
  etiquetaDeSessao,
  esquecerTudo,
  invalidarSessao,
  sessaoDosCookies,
} from "@/lib/auth/cache-curto";
import { validarIdentidade, type RespostaDeIdentidade } from "@/lib/supabase/identidade-validada";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const relogio = { agora: Date.UTC(2026, 10, 11, 12, 0, 0) };

function cookieDeSessao(segundosDeVida = 3600): { name: string; value: string } {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const expiraEm = Math.floor(relogio.agora / 1000) + segundosDeVida;
  const token = `${b64({ alg: "HS256" })}.${b64({ sub: USER_ID, exp: expiraEm })}.assinatura`;
  return {
    name: "sb-deskcomm-auth",
    value: `base64-${b64({
      access_token: token,
      refresh_token: "refresh-de-teste",
      expires_at: expiraEm,
    })}`,
  };
}

const ok = (): RespostaDeIdentidade => ({ data: { user: { id: USER_ID } }, error: null });

beforeEach(() => {
  relogio.agora = Date.UTC(2026, 10, 11, 12, 0, 0);
  vi.spyOn(Date, "now").mockImplementation(() => relogio.agora);
  esquecerTudo();
});

afterEach(() => {
  vi.restoreAllMocks();
  esquecerTudo();
});

describe("validarIdentidade — o cache do proxy", () => {
  it("sem cookie de sessão não há chave: carrega sempre", async () => {
    const carregar = vi.fn(async () => ok());
    await validarIdentidade(carregar, []);
    await validarIdentidade(carregar, []);
    expect(carregar).toHaveBeenCalledTimes(2);
  });

  it("mesma sessão dentro da janela: uma carga só", async () => {
    const carregar = vi.fn(async () => ok());
    const cookies = [cookieDeSessao()];
    await validarIdentidade(carregar, cookies);
    await validarIdentidade(carregar, cookies);
    expect(carregar).toHaveBeenCalledTimes(1);
  });

  it("passada a janela, carrega de novo", async () => {
    const carregar = vi.fn(async () => ok());
    const cookies = [cookieDeSessao()];
    await validarIdentidade(carregar, cookies);
    relogio.agora += TTL_CURTO_MS + 1;
    await validarIdentidade(carregar, cookies);
    expect(carregar).toHaveBeenCalledTimes(2);
  });

  it("resposta sem usuário (sessão inválida) NÃO é guardada", async () => {
    const carregar = vi.fn(
      async (): Promise<RespostaDeIdentidade> => ({
        data: { user: null },
        error: { name: "AuthApiError", message: "invalid JWT" },
      }),
    );
    const cookies = [cookieDeSessao()];
    await validarIdentidade(carregar, cookies);
    await validarIdentidade(carregar, cookies);
    expect(carregar).toHaveBeenCalledTimes(2);
  });

  it("token a menos da margem do `exp` não se cacheia — quem renova é o getUser", async () => {
    const carregar = vi.fn(async () => ok());
    const cookies = [cookieDeSessao(3)];
    await validarIdentidade(carregar, cookies);
    await validarIdentidade(carregar, cookies);
    expect(carregar).toHaveBeenCalledTimes(2);
  });

  it("sem `exp` legível no JWT, caminho direto", async () => {
    const carregar = vi.fn(async () => ok());
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const cookies = [
      {
        name: "sb-deskcomm-auth",
        value: `base64-${b64({ access_token: "sem.pontos", refresh_token: "r" })}`,
      },
    ];
    await validarIdentidade(carregar, cookies);
    await validarIdentidade(carregar, cookies);
    expect(carregar).toHaveBeenCalledTimes(2);
  });

  it("a chave é a MESMA do handler: entrada escrita pelo #3696 já serve o proxy", async () => {
    const cookies = [cookieDeSessao()];
    const sessao = sessaoDosCookies(cookies);
    expect(sessao).not.toBeNull();

    // O que `lib/auth/server.ts` faz na primeira requisição do handler.
    await comCacheCurto<RespostaDeIdentidade>({
      chave: `sessao:${sessao!.chave}`,
      etiquetas: [etiquetaDeSessao(sessao!.chave)],
      ate: sessao!.expiraEm ?? undefined,
      carregar: async () => ok(),
    });

    const carregar = vi.fn(async () => ok());
    const resposta = await validarIdentidade(carregar, cookies);
    expect(resposta.data.user).toEqual({ id: USER_ID });
    expect(carregar).not.toHaveBeenCalled();
  });

  it("invalidarSessao (o que a saída faz) derruba a entrada do proxy", async () => {
    const carregar = vi.fn(async () => ok());
    const cookies = [cookieDeSessao()];
    await validarIdentidade(carregar, cookies);
    invalidarSessao(sessaoDosCookies(cookies)!.chave);
    await validarIdentidade(carregar, cookies);
    expect(carregar).toHaveBeenCalledTimes(2);
  });
});
