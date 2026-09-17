import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  MOTIVO_API_INCOMPATIVEL,
  MOTIVO_PACOTE_ILEGIVEL,
  lerManifestoAdmitido,
  montarAnterior,
  montarInstalada,
} from "./instalada";

const INSTALACAO = "00000000-0000-4000-8000-000000000031";
const ARTEFATO = "00000000-0000-4000-8000-000000000032";
const CATALOGO = "00000000-0000-4000-8000-000000000033";

const manifesto = {
  format_version: 1,
  profile: "declarative",
  publisher: "acme",
  name: "tarefas-praticas",
  version: "1.2.3",
  license: "MIT",
  host_api: { min: 1, max: 1 },
  permissions: ["navigation.tasks"],
  dependencies: [],
  data: { mode: "none" },
  display: {
    title: { "pt-BR": "Tarefas práticas" },
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
        description: { "pt-BR": "Abra a lista de tarefas." },
        icon: "BookOpen",
        blocks: [{ heading: { "pt-BR": "Comece" }, body: { "pt-BR": "Revise as tarefas abertas." } }],
        action: { label: { "pt-BR": "Abrir tarefas" }, capability: "tasks.open" },
      },
    ],
  },
};

const sha = (texto: string) => createHash("sha256").update(texto).digest("hex");
function artefato(documento = JSON.stringify(manifesto), hashDe = documento) {
  return {
    id: ARTEFATO,
    sha256: sha(hashDe),
    byte_length: Buffer.byteLength(hashDe),
    manifest: { version: "1.2.3" },
    document: documento,
  };
}
const item = {
  id: INSTALACAO,
  catalog_id: CATALOGO,
  artifact_id: ARTEFATO,
  publisher: "acme",
  name: "tarefas-praticas",
  version: "1.2.3",
  revision: 2,
  removed_at: null,
};
const catalogo = { id: CATALOGO, origin: "https://catalogo.example" };
const ativa = {
  enabled: true,
  revision: 3,
  configuration: { density: "compact" as const, show_description: false },
  deactivated_by_removal_at: null,
};

describe("montarInstalada", () => {
  it("pacote legível vira view compatível com o display do próprio manifesto", () => {
    const view = montarInstalada({ item, artifact: artefato(), catalog: catalogo, binding: ativa });
    expect(view.compatible).toBe(true);
    expect(view.compatibility_reason).toBeNull();
    expect(view.display.title).toEqual({ "pt-BR": "Tarefas práticas" });
    expect(view).toMatchObject({
      enabled: true,
      revision: 3,
      installation_revision: 2,
      catalog_id: CATALOGO,
      origin: "https://catalogo.example",
    });
  });

  it("instalação removida não oferece desfazer, mesmo com anterior gravado", () => {
    const anterior = montarAnterior(artefato(), item, []);
    const removida = { ...item, removed_at: "2026-09-16T10:00:00.000Z" };
    expect(montarInstalada({ item, artifact: artefato(), catalog: catalogo, binding: ativa, previous: anterior }).previous).toEqual(anterior);
    expect(
      montarInstalada({ item: removida, artifact: artefato(), catalog: catalogo, binding: ativa, previous: anterior }),
    ).toMatchObject({ previous: null, removed_at: removida.removed_at });
  });

  it("documento que não confere com o hash gravado vira incompatível, sem derrubar a lista", () => {
    const adulterado = artefato(JSON.stringify({ ...manifesto, version: "9.9.9" }), JSON.stringify(manifesto));
    const view = montarInstalada({ item, artifact: adulterado, catalog: catalogo, binding: ativa });
    expect(view.compatible).toBe(false);
    expect(view.compatibility_reason).toBe(MOTIVO_PACOTE_ILEGIVEL);
    expect(view.display.title).toEqual({ "pt-BR": "acme/tarefas-praticas" });
  });

  it("pacote íntegro que esta versão já não sabe ler vira incompatível, sem lançar", () => {
    const documento = JSON.stringify({ ...manifesto, profile: "executable" });
    const view = montarInstalada({ item, artifact: artefato(documento), catalog: catalogo, binding: ativa });
    expect(view.compatible).toBe(false);
    expect(view.compatibility_reason).toBe(MOTIVO_PACOTE_ILEGIVEL);
  });

  it("artefato ausente vira incompatível e preserva o vínculo, para ainda ser possível desativar", () => {
    const view = montarInstalada({ item, artifact: undefined, catalog: undefined, binding: ativa });
    expect(view).toMatchObject({ compatible: false, enabled: true, revision: 3, origin: "" });
    expect(view.configuration).toEqual(ativa.configuration);
  });
});

describe("lerManifestoAdmitido", () => {
  it("devolve o motivo em vez de lançar", () => {
    expect(lerManifestoAdmitido(artefato()).ok).toBe(true);
    const adulterado = artefato("{}", JSON.stringify(manifesto));
    expect(lerManifestoAdmitido(adulterado)).toEqual({ ok: false, code: "extension_storage_failed" });
  });
});

describe("montarAnterior", () => {
  const entrada = (sha256: string, version = "1.2.3") => ({
    publisher: "acme",
    name: "tarefas-praticas",
    version,
    license: "MIT",
    host_api: { min: 1, max: 1 },
    display: manifesto.display,
    permissions: ["navigation.tasks"],
    sha256,
    byte_length: 1,
  }) as unknown as Parameters<typeof montarAnterior>[2][number];

  it("diz a versão, a compatibilidade e se os MESMOS bytes seguem no catálogo", () => {
    const anterior = artefato();
    expect(montarAnterior(anterior, item, [entrada(anterior.sha256)])).toEqual({
      version: "1.2.3",
      compatible: true,
      compatibility_reason: null,
      in_catalog: true,
    });
    expect(montarAnterior(anterior, item, [entrada("f".repeat(64))]).in_catalog).toBe(false);
    expect(montarAnterior(anterior, item, [entrada(anterior.sha256, "1.2.4")]).in_catalog).toBe(false);
  });

  it("anterior ilegível ou de outra API continua com a versão e o motivo, sem lançar", () => {
    const ilegivel = artefato(JSON.stringify({ ...manifesto, profile: "executable" }));
    expect(montarAnterior(ilegivel, item, [])).toMatchObject({
      version: "1.2.3",
      compatible: false,
      compatibility_reason: MOTIVO_PACOTE_ILEGIVEL,
    });
    const outraApi = artefato(JSON.stringify({ ...manifesto, host_api: { min: 2, max: 2 } }));
    expect(montarAnterior(outraApi, item, [])).toMatchObject({
      version: "1.2.3",
      compatible: false,
      compatibility_reason: MOTIVO_API_INCOMPATIVEL,
    });
    expect(montarAnterior(undefined, item, [])).toMatchObject({ version: "", compatible: false, in_catalog: false });
  });
});
