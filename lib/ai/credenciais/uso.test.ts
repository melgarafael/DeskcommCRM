/**
 * O número que a tela mostra tem de ser o MESMO que trava a exclusão.
 *
 * Antes esta régua contava só a versão PUBLICADA de agente não arquivado — e o
 * operador via "Em uso por 0" numa credencial que o banco recusava excluir, por
 * causa das versões em rascunho e superseded que a FK `ON DELETE RESTRICT`
 * também enxerga. Contar publicadas responde "quantos agentes usam de verdade";
 * a pergunta do botão de excluir é "o banco me deixa apagar isto", e a resposta
 * é o total de `ai_agent_versions` que apontam para a credencial.
 */
import { describe, expect, it } from "vitest";
import { contarUsoQueBloqueia, versoesQueBloqueiam, type VersaoVinculada } from "./uso";

const linha = (
  over: Partial<VersaoVinculada> & {
    publicada?: string | null;
    arquivado?: boolean;
    nome?: string | null;
  },
): VersaoVinculada => ({
  id: over.id ?? "v1",
  credential_id: over.credential_id ?? "c1",
  version_number: over.version_number ?? 1,
  status: over.status ?? "draft",
  ai_agents:
    over.ai_agents === undefined
      ? {
          id: "a1",
          name: over.nome === undefined ? "Atendimento" : over.nome ?? "",
          archived_at: over.arquivado ? "2026-01-01T00:00:00Z" : null,
          published_version_id: over.publicada === undefined ? null : over.publicada,
        }
      : over.ai_agents,
});

describe("contarUsoQueBloqueia", () => {
  it("conta a versão em RASCUNHO — é ela que trava a FK, e a régua antiga dizia 0", () => {
    expect(contarUsoQueBloqueia([linha({ id: "v1", status: "draft" })])).toEqual({ c1: 1 });
  });

  it("conta a versão SUPERSEDED — continuou existindo e continuou travando", () => {
    expect(contarUsoQueBloqueia([linha({ id: "v1", status: "superseded" })])).toEqual({
      c1: 1,
    });
  });

  it("conta a versão publicada", () => {
    expect(
      contarUsoQueBloqueia([linha({ id: "v1", status: "published", publicada: "v1" })]),
    ).toEqual({ c1: 1 });
  });

  it("conta versão de agente ARQUIVADO — arquivar não apaga versão, e a FK segue travando", () => {
    expect(contarUsoQueBloqueia([linha({ id: "v1", arquivado: true })])).toEqual({ c1: 1 });
  });

  it("soma por credencial e não inventa chave para quem não tem versão", () => {
    const r = contarUsoQueBloqueia([
      linha({ id: "v1", credential_id: "c1" }),
      linha({ id: "v2", credential_id: "c1" }),
      linha({ id: "v3", credential_id: "c2" }),
    ]);
    expect(r).toEqual({ c1: 2, c2: 1 });
    expect(r.c3).toBeUndefined();
  });
});

describe("versoesQueBloqueiam", () => {
  it("nomeia agente e versão para a mensagem dizer ONDE ir", () => {
    const r = versoesQueBloqueiam([
      linha({
        id: "v9",
        credential_id: "c1",
        version_number: 4,
        status: "draft",
        nome: "Triagem",
      }),
    ]);
    expect(r.c1).toEqual([
      { versionId: "v9", versionNumber: 4, status: "draft", agentName: "Triagem" },
    ]);
  });

  it("aceita o join como array (o PostgREST varia a cardinalidade)", () => {
    const r = versoesQueBloqueiam([
      {
        id: "v9",
        credential_id: "c1",
        version_number: 2,
        status: "superseded",
        ai_agents: [{ id: "a1", name: "SDR", archived_at: null, published_version_id: "v1" }],
      },
    ]);
    expect(r.c1?.[0]).toMatchObject({ agentName: "SDR", versionNumber: 2 });
  });

  it("a credencial sem versão não aparece no mapa (nada a listar)", () => {
    expect(versoesQueBloqueiam([])).toEqual({});
  });
});
