/**
 * O CONTRATO de procedência da conexão oficial (issue #4074).
 *
 * O que este arquivo tranca, cada caso com um desfecho:
 *
 *   1. conexão nascida por Embedded Signup é reconhecida como tal, e a que veio
 *      do formulário como `token_manual` — o vocabulário é fechado;
 *   2. valor fora do vocabulário é RECUSADO (`ok: false`), não chutado como
 *      manual: procedência errada é pior que procedência ausente;
 *   3. linha anterior à coluna (`null`) é inferida como manual com
 *      `inferida: true` — a tela consegue dizer que ninguém registrou;
 *   4. nada que sai daqui carrega credencial: objeto de saída tem chaves fixas e
 *      o valor recusado não é ecoado em resultado nem em erro;
 *   5. gravação usa o service role com `organization_id` no filtro, e banco sem
 *      a coluna (42703) não derruba a conexão que já está no ar.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  ORIGEM_DO_EMBEDDED_SIGNUP,
  ORIGEM_DO_TOKEN_MANUAL,
  lerOrigemDaConexao,
  origemGravada,
  patchDaOrigem,
  registrarOrigemDaConexao,
} from "@/lib/channels/meta/origem-da-conexao";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const ORG = "org-1";
const SESSAO = "sessao-1";
const TOKEN_CIFRADO = "\\xdeadbeef-cifrado";

interface Chamada {
  tabela: string;
  op: "select" | "update";
  colunas: string;
  patch: Record<string, unknown> | null;
  filtros: Array<[string, unknown]>;
}

/** Dublê mínimo do client de service role — mede filtros e o patch gravado. */
function adminFalso(opts: { erro?: { code?: string; message?: string }; linha?: Record<string, unknown> | null } = {}) {
  const chamadas: Chamada[] = [];

  function construtor(tabela: string, op: "select" | "update", patch: Record<string, unknown> | null) {
    const chamada: Chamada = { tabela, op, colunas: "", patch, filtros: [] };
    chamadas.push(chamada);
    const resultado = () =>
      Promise.resolve(
        opts.erro
          ? { data: null, error: opts.erro }
          : { data: op === "select" ? (opts.linha ?? null) : null, error: null },
      );

    const no = {
      select(colunas?: string) {
        chamada.colunas = colunas ?? "";
        return no;
      },
      eq(coluna: string, valor: unknown) {
        chamada.filtros.push([coluna, valor]);
        return no;
      },
      maybeSingle() {
        return resultado();
      },
      then<T>(ok: (v: unknown) => T, falha?: (e: unknown) => T) {
        return resultado().then(ok, falha);
      },
    };
    return no;
  }

  const client = {
    from(tabela: string) {
      return {
        select: (colunas?: string) => construtor(tabela, "select", null).select(colunas),
        update: (patch: Record<string, unknown>) => construtor(tabela, "update", patch),
      };
    },
  };

  return { client: client as unknown as SupabaseClient, chamadas };
}

beforeEach(() => vi.clearAllMocks());

describe("origemGravada — vocabulário fechado", () => {
  it("reconhece a conexão nascida por Embedded Signup", () => {
    expect(origemGravada(ORIGEM_DO_EMBEDDED_SIGNUP)).toEqual({
      ok: true,
      origem: "embedded_signup",
      rotulo: "Embedded Signup da Meta",
      inferida: false,
    });
  });

  it("reconhece a conexão por token colado à mão", () => {
    expect(origemGravada("token_manual")).toEqual({
      ok: true,
      origem: "token_manual",
      rotulo: "token colado à mão",
      inferida: false,
    });
  });

  it("recusa valor fora do vocabulário em vez de rotular como manual", () => {
    for (const invalido of ["", "EMBEDDED_SIGNUP", "embedded", "manual", 42, {}, []]) {
      expect(origemGravada(invalido), String(invalido)).toEqual({
        ok: false,
        motivo: "origem_desconhecida",
      });
    }
  });

  it("linha anterior à coluna é inferida como manual, e DIZ que inferiu", () => {
    for (const ausente of [null, undefined]) {
      expect(origemGravada(ausente)).toEqual({
        ok: true,
        origem: "token_manual",
        rotulo: "token colado à mão",
        inferida: true,
      });
    }
  });

  it("não ecoa o valor recusado — token colado no lugar da origem não vira log", () => {
    const segredo = "EAAG-token-de-usuario-de-sistema";
    const leitura = origemGravada(segredo);
    expect(leitura.ok).toBe(false);
    expect(JSON.stringify(leitura)).not.toContain(segredo);
  });
});

describe("patchDaOrigem — o que a próxima porta pode gravar", () => {
  it("grava exatamente a coluna da origem", () => {
    expect(patchDaOrigem(ORIGEM_DO_EMBEDDED_SIGNUP)).toEqual({
      ok: true,
      patch: { meta_connection_origin: "embedded_signup" },
    });
  });

  it("recusa origem inventada, sem repetir o que recebeu", () => {
    const segredo = "codigo-do-embedded-signup-AQ123";
    const patch = patchDaOrigem(segredo);
    expect(patch).toEqual({ ok: false, motivo: "origem_invalida" });
    expect(JSON.stringify(patch)).not.toContain(segredo);
  });
});

describe("registrarOrigemDaConexao — gravação tolerante", () => {
  it("grava com organization_id e id no filtro (client service role bypassa RLS)", async () => {
    const { client, chamadas } = adminFalso();
    const desfecho = await registrarOrigemDaConexao(client, {
      organizationId: ORG,
      channelSessionId: SESSAO,
      origem: ORIGEM_DO_TOKEN_MANUAL,
    });

    expect(desfecho).toEqual({ gravada: true });
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]!.tabela).toBe("channel_sessions");
    expect(chamadas[0]!.op).toBe("update");
    expect(chamadas[0]!.patch).toEqual({ meta_connection_origin: "token_manual" });
    expect(chamadas[0]!.filtros).toEqual([
      ["organization_id", ORG],
      ["id", SESSAO],
    ]);
  });

  it("banco sem a coluna (42703) não derruba a conexão já gravada", async () => {
    const { client } = adminFalso({ erro: { code: "42703", message: "column does not exist" } });
    await expect(
      registrarOrigemDaConexao(client, {
        organizationId: ORG,
        channelSessionId: SESSAO,
        origem: ORIGEM_DO_TOKEN_MANUAL,
      }),
    ).resolves.toEqual({ gravada: false, motivo: "coluna_ausente" });
  });

  it("outra falha de banco vira motivo, não exceção", async () => {
    const { client } = adminFalso({ erro: { code: "42501", message: "permission denied" } });
    await expect(
      registrarOrigemDaConexao(client, {
        organizationId: ORG,
        channelSessionId: SESSAO,
        origem: ORIGEM_DO_TOKEN_MANUAL,
      }),
    ).resolves.toEqual({ gravada: false, motivo: "falha" });
  });

  it("origem inválida não chega ao banco", async () => {
    const { client, chamadas } = adminFalso();
    const desfecho = await registrarOrigemDaConexao(client, {
      organizationId: ORG,
      channelSessionId: SESSAO,
      origem: "EAAG-token",
    });
    expect(desfecho).toEqual({ gravada: false, motivo: "origem_invalida" });
    expect(chamadas).toHaveLength(0);
  });
});

describe("lerOrigemDaConexao — leitura que não vaza a linha", () => {
  it("lê Embedded Signup da sessão", async () => {
    const { client, chamadas } = adminFalso({
      linha: { meta_connection_origin: "embedded_signup", meta_token_encrypted: TOKEN_CIFRADO },
    });
    const leitura = await lerOrigemDaConexao(client, { organizationId: ORG, channelSessionId: SESSAO });

    expect(leitura).toEqual({
      ok: true,
      origem: "embedded_signup",
      rotulo: "Embedded Signup da Meta",
      inferida: false,
    });
    expect(Object.keys(leitura).sort()).toEqual(["inferida", "ok", "origem", "rotulo"]);
    expect(JSON.stringify(leitura)).not.toContain(TOKEN_CIFRADO);
    expect(chamadas[0]!.colunas).toBe("meta_connection_origin");
    expect(chamadas[0]!.filtros).toEqual([
      ["organization_id", ORG],
      ["id", SESSAO],
    ]);
  });

  it("sessão anterior à 9328 volta como manual inferida", async () => {
    const { client } = adminFalso({ linha: { meta_connection_origin: null } });
    await expect(
      lerOrigemDaConexao(client, { organizationId: ORG, channelSessionId: SESSAO }),
    ).resolves.toEqual({
      ok: true,
      origem: "token_manual",
      rotulo: "token colado à mão",
      inferida: true,
    });
  });

  it("valor corrompido na coluna falha fechado", async () => {
    const { client } = adminFalso({ linha: { meta_connection_origin: "colado-no-sql" } });
    await expect(
      lerOrigemDaConexao(client, { organizationId: ORG, channelSessionId: SESSAO }),
    ).resolves.toEqual({ ok: false, motivo: "origem_desconhecida" });
  });

  it("banco sem a coluna não derruba a tela do canal", async () => {
    const { client } = adminFalso({ erro: { code: "42703", message: "column does not exist" } });
    await expect(
      lerOrigemDaConexao(client, { organizationId: ORG, channelSessionId: SESSAO }),
    ).resolves.toEqual({ ok: false, motivo: "coluna_ausente" });
  });
});
