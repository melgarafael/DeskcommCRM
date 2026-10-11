import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { ExtensionError } from "./errors";
import {
  checkCompatibility,
  configurationSchema,
  EXTENSION_LIMITS,
  localize,
  parseCatalog,
  parseManifest,
  validateCatalogSnapshot,
  validateArtifact,
  type CatalogEntry,
  type ExtensionManifest,
} from "./manifest";

/**
 * Os cards de um manifesto DECLARATIVO — que sempre os tem. `crm_cards` virou opcional quando o
 * perfil `data` entrou (um módulo de dados não contribui card), e as fixturas daqui são todas
 * declarativas. Um helper que FALHA ALTO é melhor que `?? []`, que transformaria fixture quebrada em
 * lista vazia e num teste verde sobre nada; e melhor que `!`, que é escape de tipo.
 *
 * O retorno é TIPADO (`CardsDeclarados`). A primeira versão devolvia `unknown[]`, e aí cada card
 * virava `{}` — o `tsc` passou a reclamar de `.action`, `.id` e `.title` em vez de reclamar do
 * opcional. Helper com tipo frouxo troca um erro de tipo por outro.
 */
type CardsDeclarados = NonNullable<ExtensionManifest["contributions"]["crm_cards"]>;

function cardsDeclarados(manifesto: {
  contributions: { crm_cards?: CardsDeclarados };
}): CardsDeclarados {
  const cards = manifesto.contributions.crm_cards;
  if (!cards) throw new Error("fixture declarativa sem crm_cards — o perfil mudou?");
  return cards;
}


const encoder = new TextEncoder();

const manifest: ExtensionManifest = {
  format_version: 1,
  profile: "declarative",
  publisher: "acme",
  name: "tarefas-praticas",
  version: "1.2.3",
  license: "MIT",
  host_api: { min: 1, max: 2 },
  permissions: ["navigation.tasks"],
  dependencies: [],
  data: { mode: "none" },
  display: {
    title: { "pt-BR": "Tarefas práticas", es: "Tareas prácticas" },
    summary: { "pt-BR": "Orientações para organizar o trabalho." },
    category: "productivity",
    icon: "ListChecks",
  },
  configuration: { density: "comfortable", show_description: true },
  contributions: {
    crm_cards: [
      {
        id: "primeiros-passos",
        title: { "pt-BR": "Primeiros passos" },
        description: { "pt-BR": "Abra a lista de tarefas e organize o próximo passo." },
        icon: "BookOpen",
        blocks: [
          {
            heading: { "pt-BR": "Comece pela prioridade" },
            body: { "pt-BR": "Revise as tarefas abertas antes de criar uma nova." },
          },
        ],
        action: { label: { "pt-BR": "Abrir tarefas" }, capability: "tasks.open" },
      },
    ],
  },
};

function manifestBytes(value: unknown = manifest) {
  return encoder.encode(JSON.stringify(value));
}

function entryFor(bytes: Uint8Array, overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    publisher: manifest.publisher,
    name: manifest.name,
    version: manifest.version,
    license: manifest.license,
    host_api: manifest.host_api,
    display: manifest.display,
    permissions: manifest.permissions,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byte_length: bytes.byteLength,
    ...overrides,
  };
}

function catalogAtTransportLimit() {
  const emoji = "🧭";
  const entries = Array.from({ length: EXTENSION_LIMITS.catalogEntries }, (_, index) => ({
    publisher: "acme",
    name: `guide-${index}`,
    version: "1.0.0",
    license: "MIT" as const,
    host_api: { min: 1, max: 1_000 },
    permissions: ["navigation.tasks"] as ["navigation.tasks"],
    display: {
      title: { "pt-BR": emoji.repeat(100), es: emoji.repeat(100) },
      summary: { "pt-BR": emoji.repeat(400), es: emoji.repeat(400) },
      category: "productivity" as const,
      icon: "ListChecks" as const,
    },
    sha256: index.toString(16).padStart(64, "0"),
    byte_length: 1_000,
  }));
  const catalog = {
    format_version: 1 as const,
    origin: "https://catalog.example.test",
    revision: 1,
    entries,
  };

  let compact = JSON.stringify(catalog).replaceAll(":1000", ":1e3");
  const excess = encoder.encode(compact).byteLength - EXTENSION_LIMITS.catalogBytes;
  expect(excess).toBeGreaterThan(0);
  let remaining = Math.ceil(excess / 4);
  for (const entry of entries) {
    if (remaining === 0) break;
    const characters = [...entry.display.summary.es];
    const removed = Math.min(remaining, characters.length - 1);
    entry.display.summary.es = characters.slice(removed).join("");
    remaining -= removed;
  }
  expect(remaining).toBe(0);

  compact = JSON.stringify(catalog).replaceAll(":1000", ":1e3");
  const compactBytes = encoder.encode(compact).byteLength;
  expect(compactBytes).toBeLessThanOrEqual(EXTENSION_LIMITS.catalogBytes);
  const padding = " ".repeat(EXTENSION_LIMITS.catalogBytes - compactBytes);
  const bytes = encoder.encode(`${compact.slice(0, -1)}${padding}}`);
  expect(bytes.byteLength).toBe(EXTENSION_LIMITS.catalogBytes);
  return bytes;
}

async function expectCode(run: () => unknown | Promise<unknown>, code: ExtensionError["code"]) {
  try {
    await run();
    throw new Error("Esperava ExtensionError");
  } catch (error) {
    expect(error).toBeInstanceOf(ExtensionError);
    expect((error as ExtensionError).code).toBe(code);
    expect((error as Error).message).not.toContain("acme-secret");
  }
}

describe("manifesto declarativo", () => {
  it("faz parse do contrato completo", () => {
    expect(parseManifest(manifestBytes())).toEqual(manifest);
  });

  it("recusa propriedades desconhecidas inclusive em estruturas internas", async () => {
    await expectCode(
      () =>
        parseManifest(
          manifestBytes({
            ...manifest,
            display: { ...manifest.display, executable: "acme-secret" },
          }),
        ),
      "extension_invalid_package",
    );
  });

  it.each(["01.2.3", "1.02.3", "1.2.03", "1.2.3-beta", "v1.2.3"])(
    "recusa versão instável ou não canônica %s",
    (version) => {
      expect(() => parseManifest(manifestBytes({ ...manifest, version }))).toThrow(ExtensionError);
    },
  );

  it("limita SemVer a 64 caracteres, como a API de instalação", () => {
    const sixtyFour = `1.${"1".repeat(60)}.1`;
    expect(sixtyFour).toHaveLength(64);
    expect(parseManifest(manifestBytes({ ...manifest, version: sixtyFour })).version).toBe(
      sixtyFour,
    );
    expect(() =>
      parseManifest(manifestBytes({ ...manifest, version: `1.${"1".repeat(61)}.1` })),
    ).toThrow(ExtensionError);
  });

  it("aplica limites comuns de cards, blocos e textos", () => {
    const card = cardsDeclarados(manifest)[0]!;
    expect(() =>
      parseManifest(
        manifestBytes({
          ...manifest,
          contributions: { crm_cards: Array.from({ length: 5 }, (_, id) => ({ ...card, id })) },
        }),
      ),
    ).toThrow(ExtensionError);
    expect(() =>
      parseManifest(
        manifestBytes({
          ...manifest,
          display: { ...manifest.display, title: { "pt-BR": "x".repeat(101) } },
        }),
      ),
    ).toThrow(ExtensionError);
  });

  it.each([
    ["maiúscula e espaço", "Primeiro Passo"],
    ["barra, que muda o caminho da URL", "passo/../outro"],
    ["vazio", ""],
    ["gigante", "a".repeat(20_000)],
  ])("recusa id de card com %s", async (_caso, id) => {
    // O id vai para a URL do guia (`?card=`) e para o data-testid. Texto livre aqui
    // rendia link de 20 kB (431 no servidor) e id que não identifica nada.
    await expectCode(
      () =>
        parseManifest(
          manifestBytes({
            ...manifest,
            contributions: {
              crm_cards: [{ ...cardsDeclarados(manifest)[0]!, id }],
            },
          }),
        ),
      "extension_invalid_package",
    );
  });

  it("recusa dois cards com o mesmo id", async () => {
    const card = cardsDeclarados(manifest)[0]!;
    await expectCode(
      () =>
        parseManifest(
          manifestBytes({ ...manifest, contributions: { crm_cards: [card, { ...card }] } }),
        ),
      "extension_invalid_package",
    );
  });

  it.each(["", "   ", "\n\t"])("recusa texto localizado vazio %j sem normalizar bytes", (title) => {
    expect(() =>
      parseManifest(
        manifestBytes({
          ...manifest,
          display: { ...manifest.display, title: { "pt-BR": title } },
        }),
      ),
    ).toThrow(ExtensionError);
  });

  it("expõe schema estrito de configuração", () => {
    expect(
      configurationSchema.safeParse({ density: "compact", show_description: false }).success,
    ).toBe(true);
    expect(
      configurationSchema.safeParse({ density: "compact", show_description: false, text: "livre" })
        .success,
    ).toBe(false);
  });

  it("localiza e indica fallback para pt-BR", () => {
    const text = { "pt-BR": "Olá", es: "Hola" };
    expect(localize(text, "es")).toEqual({ text: "Hola", fallback: false });
    expect(localize(text, "en-US")).toEqual({ text: "Olá", fallback: true });
  });

  it("informa incompatibilidade por formato, perfil, API, permissão, dependência e capacidade", () => {
    expect(checkCompatibility(manifest)).toEqual({ compatible: true, reason: null });
    expect(checkCompatibility(entryFor(manifestBytes()))).toEqual({
      compatible: true,
      reason: null,
    });
    expect(checkCompatibility({ ...manifest, format_version: 2 } as never).reason).toBe(
      "format_version_unsupported",
    );
    expect(checkCompatibility({ ...manifest, profile: "code" } as never).reason).toBe(
      "profile_unsupported",
    );
    expect(checkCompatibility({ ...manifest, host_api: { min: 3, max: 4 } }).reason).toBe(
      "host_api_unsupported",
    );
    // ADR-0003, D4: o host passou a 2, e a janela do manifesto é FECHADA — quem declarou
    // atender só até 1 disse até onde garantia, e deixa de ser atendido. É comportamento
    // desejado, não regressão; o que a gestão não pode fazer é deixar isso mudo na tela.
    expect(checkCompatibility({ ...manifest, host_api: { min: 1, max: 1 } }).reason).toBe(
      "host_api_unsupported",
    );
    // Cobertura: usar uma porta sem declarar a permissão dela esconde de quem aceita a
    // extensão exatamente o que a tela existe para mostrar.
    const semCobertura = structuredClone(manifest);
    cardsDeclarados(semCobertura)[0]!.action.capability = "inbox.open";
    expect(checkCompatibility(semCobertura).reason).toBe("permission_unsupported");
    // E com a permissão declarada, a mesma porta passa.
    expect(
      checkCompatibility({ ...semCobertura, permissions: ["navigation.inbox"] }).compatible,
    ).toBe(true);
    expect(checkCompatibility({ ...manifest, permissions: ["tasks.write"] } as never).reason).toBe(
      "permission_unsupported",
    );
    expect(checkCompatibility({ ...manifest, dependencies: ["other"] } as never).reason).toBe(
      "dependency_unsupported",
    );
    const capability = structuredClone(manifest);
    (
      cardsDeclarados(capability)[0]!.action as {
        capability: string;
      }
    ).capability = "tasks.delete";
    expect(checkCompatibility(capability as never).reason).toBe("capability_unsupported");
  });
});

describe("catálogo e artefato", () => {
  it("faz parse do catálogo com origem exata", () => {
    const bytes = manifestBytes();
    const catalog = {
      format_version: 1,
      origin: "https://catalog.example.test:8443",
      revision: 1,
      entries: [entryFor(bytes)],
    };
    expect(parseCatalog(encoder.encode(JSON.stringify(catalog)))).toEqual(catalog);
  });

  it.each([
    "https://catalog.example.test/path",
    "https://user:password@catalog.example.test",
    "https://catalog.example.test?revision=1",
    "https://catalog.example.test#fragment",
    "HTTPS://catalog.example.test",
  ])("recusa origem que não seja a origem exata: %s", (origin) => {
    const artifact = manifestBytes();
    expect(() =>
      parseCatalog(
        encoder.encode(
          JSON.stringify({
            format_version: 1,
            origin,
            revision: 1,
            entries: [entryFor(artifact)],
          }),
        ),
      ),
    ).toThrow(ExtensionError);
  });

  it("recusa identidade repetida no catálogo", () => {
    const artifact = manifestBytes();
    const repeated = entryFor(artifact);
    expect(() =>
      parseCatalog(
        encoder.encode(
          JSON.stringify({
            format_version: 1,
            origin: "https://catalog.example.test",
            revision: 1,
            entries: [repeated, repeated],
          }),
        ),
      ),
    ).toThrow(ExtensionError);
  });

  it("alinha o teto de revisão aos nove dígitos persistidos", () => {
    const artifact = manifestBytes();
    const catalog = (revision: number) =>
      encoder.encode(
        JSON.stringify({
          format_version: 1,
          origin: "https://catalog.example.test",
          revision,
          entries: [entryFor(artifact)],
        }),
      );
    expect(parseCatalog(catalog(999_999_999)).revision).toBe(999_999_999);
    expect(() => parseCatalog(catalog(1_000_000_000))).toThrow(ExtensionError);
  });

  it("revalida o snapshot JSONB sem reaplicar o teto dos bytes externos", () => {
    const admittedBytes = catalogAtTransportLimit();
    const snapshot = parseCatalog(admittedBytes);
    expect(encoder.encode(JSON.stringify(snapshot)).byteLength).toBeGreaterThan(
      EXTENSION_LIMITS.catalogBytes,
    );
    expect(validateCatalogSnapshot(snapshot)).toEqual(snapshot);
  });

  it("mantém o teto dos bytes externos no documento de catálogo", () => {
    const atLimit = catalogAtTransportLimit();
    expect(parseCatalog(atLimit).entries).toHaveLength(EXTENSION_LIMITS.catalogEntries);
    const aboveLimit = new Uint8Array(atLimit.byteLength + 1);
    aboveLimit.set(atLimit);
    aboveLimit[aboveLimit.length - 1] = 0x20;
    expect(() => parseCatalog(aboveLimit)).toThrowError(
      expect.objectContaining<Partial<ExtensionError>>({ code: "extension_payload_too_large" }),
    );
  });

  it("mantém schema e limites estruturais ao revalidar JSONB", async () => {
    const artifact = manifestBytes();
    const snapshot = {
      format_version: 1,
      origin: "https://catalog.example.test",
      revision: 1,
      entries: [entryFor(artifact)],
    };
    await expectCode(
      () => validateCatalogSnapshot({ ...snapshot, executable: "acme-secret" }),
      "extension_invalid_package",
    );
    await expectCode(
      () =>
        validateCatalogSnapshot({
          ...snapshot,
          entries: Array.from({ length: EXTENSION_LIMITS.jsonNodes }, () => null),
        }),
      "extension_payload_too_large",
    );
  });

  it("recusa surrogate alto no fim de string do snapshot, como o parser externo", async () => {
    const artifact = manifestBytes();
    const snapshot = {
      format_version: 1,
      origin: "https://catalog.example.test",
      revision: 1,
      entries: [
        entryFor(artifact, {
          display: {
            ...manifest.display,
            title: { "pt-BR": "x\ud800" },
          },
        }),
      ],
    };
    await expectCode(() => validateCatalogSnapshot(snapshot), "extension_invalid_package");
  });

  it("valida tamanho, hash, identidade e metadados espelhados", async () => {
    const bytes = manifestBytes();
    await expect(validateArtifact(bytes, entryFor(bytes))).resolves.toEqual(manifest);
    await expectCode(
      () => validateArtifact(bytes, entryFor(bytes, { byte_length: bytes.byteLength + 1 })),
      "extension_invalid_package",
    );
    await expectCode(
      () => validateArtifact(bytes, entryFor(bytes, { sha256: "0".repeat(64) })),
      "extension_digest_mismatch",
    );
    await expectCode(
      () => validateArtifact(bytes, entryFor(bytes, { publisher: "outro" })),
      "extension_invalid_package",
    );
    await expectCode(
      // Precisa DIVERGIR do manifesto (que declara {1,2}) para provar o espelhamento.
      () => validateArtifact(bytes, entryFor(bytes, { host_api: { min: 1, max: 3 } })),
      "extension_invalid_package",
    );
  });
});
