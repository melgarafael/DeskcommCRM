/**
 * `modulosNaTela` — quais módulos conectados a organização abre na tela (Spec 33, F4, tarefa 1).
 *
 * Banco falso que APLICA `eq`/`in` sobre linhas de verdade, de duas organizações: o isolamento
 * não é só "o filtro foi chamado", é "a linha da outra organização não volta".
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({ env: { NEXT_PUBLIC_APP_URL: "https://crm.exemplo.com" } }));

import { modulosNaTela } from "./modulos-na-tela";

const ORG_A = "aaaaaaaa-1111-4111-8111-111111111111";
const ORG_B = "bbbbbbbb-2222-4222-8222-222222222222";
const CAT = "cccccccc-3333-4333-8333-333333333333";
const INST_1 = "dddddddd-0001-4444-8444-444444444444";
const INST_2 = "dddddddd-0002-4444-8444-444444444444";

const display = {
  title: { "pt-BR": "Comanda", es: "Comanda ES" },
  summary: { "pt-BR": "Resumo" },
  category: "sales",
  icon: "ListChecks",
};

function entrada(name: string, serviceOrigin?: string) {
  return {
    publisher: "acme",
    name,
    version: "1.0.0",
    license: "MIT",
    host_api: { min: 2, max: 2 },
    display,
    permissions: ["area.contatos.leitura"],
    sha256: "a".repeat(64),
    byte_length: 100,
    ...(serviceOrigin ? { service_origin: serviceOrigin } : {}),
  };
}

function manifesto(over: Record<string, unknown> = {}) {
  return {
    profile: "connected",
    host_api: { min: 2, max: 2 },
    permissions: ["area.contatos.leitura"],
    display,
    ...over,
  };
}

type Linha = Record<string, unknown>;
interface Mundo {
  organization_extensions: Linha[];
  extension_installations: Linha[];
  extension_catalogs: Linha[];
  erroEm?: string;
}

function mundoBase(): Mundo {
  return {
    organization_extensions: [
      { organization_id: ORG_A, installation_id: INST_1, enabled: true },
      { organization_id: ORG_B, installation_id: INST_2, enabled: true },
    ],
    extension_installations: [
      {
        id: INST_1,
        catalog_id: CAT,
        publisher: "acme",
        name: "comanda",
        version: "1.0.0",
        disabled_at: null,
        removed_at: null,
        extension_artifacts: { manifest: manifesto() },
      },
      {
        id: INST_2,
        catalog_id: CAT,
        publisher: "acme",
        name: "outro",
        version: "1.0.0",
        disabled_at: null,
        removed_at: null,
        extension_artifacts: { manifest: manifesto() },
      },
    ],
    extension_catalogs: [
      {
        id: CAT,
        snapshot: {
          format_version: 1,
          origin: "https://catalogo.exemplo.com",
          revision: 1,
          entries: [
            entrada("comanda", "https://comanda.exemplo.com"),
            entrada("outro", "https://outro.exemplo.com"),
          ],
        },
      },
    ],
  };
}

function falso(mundo: Mundo) {
  const leituras: Array<{ tabela: string; filtros: Array<[string, unknown]> }> = [];
  const cliente = {
    from(tabela: keyof Omit<Mundo, "erroEm">) {
      const filtros: Array<[string, unknown]> = [];
      leituras.push({ tabela, filtros });
      const cadeia = {
        select: () => cadeia,
        eq: (col: string, val: unknown) => (filtros.push([col, val]), cadeia),
        in: (col: string, val: unknown[]) => (filtros.push([col, val]), cadeia),
        then: (resolve: (v: unknown) => unknown) => {
          if (mundo.erroEm === tabela) return resolve({ data: null, error: { message: "falhou" } });
          const dados = mundo[tabela].filter((linha) =>
            filtros.every(([col, val]) =>
              Array.isArray(val) ? val.includes(linha[col]) : linha[col] === val,
            ),
          );
          return resolve({ data: dados, error: null });
        },
      };
      return cadeia;
    },
  };
  return { cliente: cliente as unknown as SupabaseClient, leituras };
}

describe("modulosNaTela", () => {
  it("devolve [] quando a organização não tem módulo", async () => {
    const m = mundoBase();
    m.organization_extensions = [];
    expect(await modulosNaTela(ORG_A, { supabase: falso(m).cliente })).toEqual([]);
  });

  it("devolve o módulo conectado, ligado e compatível, com título e origem", async () => {
    const r = await modulosNaTela(ORG_A, { supabase: falso(mundoBase()).cliente });
    expect(r).toEqual([
      {
        slug: "acme-comanda",
        titulo: "Comanda",
        icone: "ListChecks",
        serviceOrigin: "https://comanda.exemplo.com",
        installationId: INST_1,
      },
    ]);
  });

  it("título sai no idioma da pessoa", async () => {
    const r = await modulosNaTela(ORG_A, { locale: "es", supabase: falso(mundoBase()).cliente });
    expect(r[0]?.titulo).toBe("Comanda ES");
  });

  it("organização B nunca aparece para A (e vice-versa), e toda leitura de vínculo filtra a organização", async () => {
    const { cliente, leituras } = falso(mundoBase());
    const a = await modulosNaTela(ORG_A, { supabase: cliente });
    expect(a.map((m) => m.installationId)).toEqual([INST_1]);
    const b = await modulosNaTela(ORG_B, { supabase: falso(mundoBase()).cliente });
    expect(b.map((m) => m.installationId)).toEqual([INST_2]);
    const vinculo = leituras.find((l) => l.tabela === "organization_extensions");
    expect(vinculo?.filtros).toContainEqual(["organization_id", ORG_A]);
  });

  it("organização sem vínculo nenhum não enxerga a instalação de outra", async () => {
    const m = mundoBase();
    m.organization_extensions = [{ organization_id: ORG_B, installation_id: INST_1, enabled: true }];
    expect(await modulosNaTela(ORG_A, { supabase: falso(m).cliente })).toEqual([]);
  });

  it("recusa organizationId que não é uuid, sem tocar o banco", async () => {
    const { cliente, leituras } = falso(mundoBase());
    expect(await modulosNaTela("x' or '1'='1", { supabase: cliente })).toEqual([]);
    expect(leituras).toHaveLength(0);
  });

  it("vínculo desligado some", async () => {
    const m = mundoBase();
    m.organization_extensions[0]!.enabled = false;
    expect(await modulosNaTela(ORG_A, { supabase: falso(m).cliente })).toEqual([]);
  });

  it("instalação desativada ou removida some", async () => {
    for (const campo of ["disabled_at", "removed_at"]) {
      const m = mundoBase();
      m.extension_installations[0]![campo] = "2026-11-05T00:00:00Z";
      expect(await modulosNaTela(ORG_A, { supabase: falso(m).cliente })).toEqual([]);
    }
  });

  it("perfil que não é connected some", async () => {
    const m = mundoBase();
    m.extension_installations[0]!.extension_artifacts = {
      manifest: manifesto({ profile: "declarative" }),
    };
    expect(await modulosNaTela(ORG_A, { supabase: falso(m).cliente })).toEqual([]);
  });

  it("fora da faixa host_api some", async () => {
    const m = mundoBase();
    m.extension_installations[0]!.extension_artifacts = {
      manifest: manifesto({ host_api: { min: 99, max: 99 } }),
    };
    expect(await modulosNaTela(ORG_A, { supabase: falso(m).cliente })).toEqual([]);
  });

  it("entrada do catálogo sem service_origin some", async () => {
    const m = mundoBase();
    (m.extension_catalogs[0]!.snapshot as { entries: unknown[] }).entries = [
      entrada("comanda"),
      entrada("outro", "https://outro.exemplo.com"),
    ];
    expect(await modulosNaTela(ORG_A, { supabase: falso(m).cliente })).toEqual([]);
  });

  it("service_origin inválido (catálogo ilegível) some", async () => {
    const m = mundoBase();
    (m.extension_catalogs[0]!.snapshot as { entries: unknown[] }).entries = [
      entrada("comanda", "https://comanda.exemplo.com/caminho"),
    ];
    expect(await modulosNaTela(ORG_A, { supabase: falso(m).cliente })).toEqual([]);
  });

  it("service_origin igual à origem do CRM some", async () => {
    const m = mundoBase();
    (m.extension_catalogs[0]!.snapshot as { entries: unknown[] }).entries = [
      entrada("comanda", "https://crm.exemplo.com"),
      entrada("outro", "https://outro.exemplo.com"),
    ];
    expect(await modulosNaTela(ORG_A, { supabase: falso(m).cliente })).toEqual([]);
  });

  it("slug repetido entre publicadores some dos dois", async () => {
    const m = mundoBase();
    m.organization_extensions = [
      { organization_id: ORG_A, installation_id: INST_1, enabled: true },
      { organization_id: ORG_A, installation_id: INST_2, enabled: true },
    ];
    m.extension_installations[0]!.publisher = "a-b";
    m.extension_installations[0]!.name = "cc";
    m.extension_installations[1]!.publisher = "a";
    m.extension_installations[1]!.name = "b-cc";
    (m.extension_catalogs[0]!.snapshot as { entries: unknown[] }).entries = [
      { ...entrada("cc", "https://um.exemplo.com"), publisher: "a-b" },
      { ...entrada("b-cc", "https://dois.exemplo.com"), publisher: "a" },
    ];
    expect(await modulosNaTela(ORG_A, { supabase: falso(m).cliente })).toEqual([]);
  });

  it("erro do banco em qualquer leitura devolve [] (lado seguro)", async () => {
    for (const tabela of ["organization_extensions", "extension_installations", "extension_catalogs"]) {
      const m = mundoBase();
      m.erroEm = tabela;
      expect(await modulosNaTela(ORG_A, { supabase: falso(m).cliente })).toEqual([]);
    }
  });
});
