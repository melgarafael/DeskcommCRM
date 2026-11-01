/**
 * O que o aviso mostra com a tela bloqueada — a redação que nega por padrão.
 *
 * Roda com: npx vitest run lib/notifications/tela-bloqueada.test.ts
 */
import { describe, expect, it } from "vitest";

import type { ConteudoNaTelaBloqueada } from "@/lib/schemas/settings";

import type { PushPayload } from "./push_payload";
import { lerTelaBloqueada, redigirParaATelaBloqueada } from "./tela-bloqueada";

const completo: PushPayload = {
  title: "Ana",
  body: "oi",
  icon: "https://x",
  corpoSemPrevia: "Nova mensagem",
  tag: "msg:c1",
  href: "/app/inbox?id=c1",
};

describe("redigirParaATelaBloqueada", () => {
  it("oculto: título neutro, sem corpo nem ícone; tag e href seguem", () => {
    expect(redigirParaATelaBloqueada(completo, "oculto", "pt-BR")).toStrictEqual({
      title: "Novo aviso",
      body: "",
      tag: "msg:c1",
      href: "/app/inbox?id=c1",
    });
  });

  it("oculto: o título neutro sai no idioma da organização", () => {
    expect(redigirParaATelaBloqueada(completo, "oculto", "es").title).toBe("Nuevo aviso");
  });

  it("nome: o corpo é o declarado sem prévia; título e ícone ficam", () => {
    expect(redigirParaATelaBloqueada(completo, "nome", "pt-BR")).toStrictEqual({
      title: "Ana",
      body: "Nova mensagem",
      icon: "https://x",
      tag: "msg:c1",
      href: "/app/inbox?id=c1",
    });
  });

  it("nome: produtor que não declarou o corpo sem prévia sai com corpo vazio", () => {
    const { corpoSemPrevia: _fora, ...semDeclarar } = completo;
    void _fora;
    expect(redigirParaATelaBloqueada(semDeclarar, "nome", "pt-BR").body).toBe("");
  });

  it("nome_e_previa: igual ao payload, menos o corpo sem prévia", () => {
    expect(redigirParaATelaBloqueada(completo, "nome_e_previa", "pt-BR")).toStrictEqual({
      title: "Ana",
      body: "oi",
      icon: "https://x",
      tag: "msg:c1",
      href: "/app/inbox?id=c1",
    });
  });

  it("modo desconhecido cai no oculto", () => {
    expect(redigirParaATelaBloqueada(completo, "tudo" as ConteudoNaTelaBloqueada, "pt-BR")).toStrictEqual(
      redigirParaATelaBloqueada(completo, "oculto", "pt-BR"),
    );
  });

  it.each(["oculto", "nome", "nome_e_previa"] as const)(
    "%s: campo desconhecido do produtor nunca sai",
    (modo) => {
      const comExtra = { ...completo, segredo: "x" } as PushPayload;
      const chaves = Object.keys(redigirParaATelaBloqueada(comExtra, modo, "pt-BR"));
      expect(chaves.every((c) => ["title", "body", "tag", "href", "icon"].includes(c))).toBe(true);
    },
  );
});

function dbCom(resposta: { data: unknown; error: { message: string } | null }) {
  const filtros: Array<[string, string, unknown]> = [];
  const db = {
    from: (tabela: string) => {
      const q = {
        select: () => q,
        eq: (col: string, val: unknown) => {
          filtros.push([tabela, col, val]);
          return q;
        },
        maybeSingle: async () => resposta,
      };
      return q;
    },
  };
  return { db: db as never, filtros };
}

describe("lerTelaBloqueada", () => {
  it("chave ausente → 'nome', com o idioma da organização", async () => {
    const { db, filtros } = dbCom({ data: { settings: {}, locale: "es" }, error: null });
    expect(await lerTelaBloqueada(db, "org-1")).toEqual({ modo: "nome", idioma: "es" });
    expect(filtros).toEqual([["organizations", "id", "org-1"]]);
  });

  it("valor lixo → 'nome'", async () => {
    const { db } = dbCom({ data: { settings: { notificacoes: { conteudo_na_tela_bloqueada: 9 } }, locale: null }, error: null });
    expect((await lerTelaBloqueada(db, "org-1")).modo).toBe("nome");
  });

  it("valor gravado volta", async () => {
    const { db } = dbCom({
      data: { settings: { notificacoes: { conteudo_na_tela_bloqueada: "nome_e_previa" } }, locale: "pt-BR" },
      error: null,
    });
    expect((await lerTelaBloqueada(db, "org-1")).modo).toBe("nome_e_previa");
  });

  it("erro de leitura → 'oculto'", async () => {
    const { db } = dbCom({ data: null, error: { message: "fora" } });
    expect((await lerTelaBloqueada(db, "org-1")).modo).toBe("oculto");
  });

  it("organização inexistente → 'oculto'", async () => {
    const { db } = dbCom({ data: null, error: null });
    expect((await lerTelaBloqueada(db, "org-1")).modo).toBe("oculto");
  });
});
