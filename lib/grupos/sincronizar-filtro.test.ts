// lib/grupos/sincronizar-filtro.test.ts — I1: a (re)conexão do número ressincroniza o filtro de grupos.
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { sincronizarRecebimentoDeGrupos } from "./sincronizar-filtro";

const ORG = "11111111-1111-4111-8111-111111111111";
const SESS = "22222222-2222-4222-8222-222222222222";

function adminComLigados(ligados: number | Error) {
  const filtros: Array<[string, unknown]> = [];
  const tabelas: string[] = [];
  const builder = {
    select: () => builder,
    eq(c: string, v: unknown) {
      filtros.push([c, v]);
      return builder;
    },
    then(res: (v: unknown) => unknown, rej: (e: unknown) => unknown) {
      return ligados instanceof Error
        ? Promise.resolve({ count: null, error: ligados }).then(res, rej)
        : Promise.resolve({ count: ligados, error: null }).then(res, rej);
    },
  };
  const admin = {
    from: (t: string) => {
      tabelas.push(t);
      return builder;
    },
  } as unknown as SupabaseClient;
  return { admin, filtros, tabelas };
}

const e = { organizationId: ORG, channelSessionId: SESS, sessionRef: "sess_x" };

describe("sincronizarRecebimentoDeGrupos", () => {
  it("sessão com grupo ligado no banco pede ao WhatsApp para RECEBER grupos, filtrando pela organização", async () => {
    const { admin, filtros, tabelas } = adminComLigados(2);
    const definir = vi.fn(async () => true);
    await expect(sincronizarRecebimentoDeGrupos(admin, definir, e)).resolves.toBe(
      "sincronizado",
    );
    expect(definir).toHaveBeenCalledWith("sess_x", true);
    expect(tabelas).toEqual(["channel_session_groups"]);
    expect(filtros).toEqual(
      expect.arrayContaining([
        ["organization_id", ORG],
        ["channel_session_id", SESS],
        ["enabled", true],
      ]),
    );
  });

  it("sessão sem nenhum grupo ligado pede para IGNORAR grupos", async () => {
    const { admin } = adminComLigados(0);
    const definir = vi.fn(async () => true);
    await sincronizarRecebimentoDeGrupos(admin, definir, e);
    expect(definir).toHaveBeenCalledWith("sess_x", false);
  });

  it("banco indisponível: não decide às cegas, não toca no WhatsApp", async () => {
    const { admin } = adminComLigados(new Error("fora do ar"));
    const definir = vi.fn(async () => true);
    await expect(sincronizarRecebimentoDeGrupos(admin, definir, e)).resolves.toBe(
      "sem_leitura",
    );
    expect(definir).not.toHaveBeenCalled();
  });

  it("nunca lança, nem quando o WhatsApp falha — a conexão do número vale mais que o filtro", async () => {
    const { admin } = adminComLigados(1);
    const definir = vi.fn(async () => {
      throw new Error("timeout");
    });
    await expect(sincronizarRecebimentoDeGrupos(admin, definir, e)).resolves.toBe(
      "nao_confirmado",
    );
  });
});
