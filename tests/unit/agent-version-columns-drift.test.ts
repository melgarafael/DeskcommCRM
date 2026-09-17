/**
 * A lista de colunas de `ai_agent_versions` está copiada em 7 arquivos (as rotas
 * REST, a server action e a página do agente). Adicionar uma coluna nova em
 * apenas alguns deles não quebra typecheck nem teste nenhum — o sintoma aparece
 * só na tela, como um campo que "se desmarca sozinho" depois do refresh, e o
 * save seguinte grava o valor errado por cima.
 *
 * Foi exatamente o que aconteceu com `cases_enabled` (spec 15, Wave 5): entrou
 * em 2 dos 7 arquivos. Este teste trava a divergência de qualquer coluna futura,
 * não só dessa — enquanto as cópias existirem, elas têm que ser idênticas.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { versionCreateSchema } from "@/lib/ai/agents/validation";

const ROOT = process.cwd();

/** Todo arquivo que carrega uma cópia da lista de colunas de versão. */
const FILES_WITH_VERSION_COLUMNS = [
  "app/app/ai/agents/[id]/_actions.ts",
  "app/app/ai/agents/[id]/page.tsx",
  "app/api/v1/ai/agents/route.ts",
  "app/api/v1/ai/agents/[id]/versions/route.ts",
  "app/api/v1/ai/agents/[id]/versions/[vid]/route.ts",
  // A cópia da rota /duplicate mudou de casa: a implementação agora é
  // compartilhada com o botão "Duplicar" da lista, em lib/ai/agents/duplicate.ts.
  // O arquivo vigiado é onde a lista mora, não onde ela morava.
  "lib/ai/agents/duplicate.ts",
];

/** Extrai o conteúdo da string atribuída a VERSION_COLUMNS. */
function versionColumnsOf(relPath: string): string[] {
  const source = readFileSync(join(ROOT, relPath), "utf8");
  const match = /VERSION_COLUMNS\s*(?::\s*string)?\s*=\s*\n?\s*"([^"]+)"/.exec(source);
  if (match === null) {
    throw new Error(`VERSION_COLUMNS não encontrado em ${relPath}`);
  }
  return (match[1] ?? "").split(",").map((c) => c.trim()).filter((c) => c.length > 0);
}

describe("VERSION_COLUMNS de ai_agent_versions", () => {
  it("é idêntico em todos os arquivos que o copiam", () => {
    const [firstFile, ...restFiles] = FILES_WITH_VERSION_COLUMNS;
    if (firstFile === undefined) throw new Error("lista de arquivos vazia");
    const expected = versionColumnsOf(firstFile);
    expect(expected.length).toBeGreaterThan(10);

    for (const file of restFiles) {
      const columns = versionColumnsOf(file);
      // Compara como conjunto ordenado: ordem no SELECT não importa, presença sim.
      expect({ file, columns: [...columns].sort() }).toEqual({
        file,
        columns: [...expected].sort(),
      });
    }
  });

  it("inclui as flags por-agente que a tela edita", () => {
    // Regressão direta do bug do cases_enabled: uma flag que a tela grava mas o
    // SELECT não devolve volta como `false` no próximo render.
    for (const file of FILES_WITH_VERSION_COLUMNS) {
      const columns = versionColumnsOf(file);
      expect(columns).toContain("handoff_tool_enabled");
      expect(columns).toContain("cases_enabled");
      expect(columns).toContain("split_messages");
      expect(columns).toContain("split_max_chars");
    }
  });
});

/**
 * O SELECT idêntico não basta: o payload do form passa por `versionCreateSchema`,
 * que é `.strict()`. Coluna ausente do schema faz o parse REJEITAR o save inteiro
 * (ou, se fosse não-strict, silenciosamente descartar o campo). Foi o segundo elo
 * quebrado do split de mensagens: a coluna existia no banco e no runtime, mas o
 * schema não a conhecia, então a tela nunca conseguiria gravá-la.
 */
describe("versionCreateSchema aceita as flags por-agente que a tela edita", () => {
  const base = {
    system_prompt: "Você é um atendente de testes.",
    provider: "anthropic" as const,
    model: "claude-sonnet-4-6",
    credential_id: "11111111-1111-4111-8111-111111111111",
    channel_session_id: "22222222-2222-4222-8222-222222222222",
  };

  it("preserva split_messages/split_max_chars no parse", () => {
    const parsed = versionCreateSchema.safeParse({
      ...base,
      split_messages: true,
      split_max_chars: 240,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.split_messages).toBe(true);
    expect(parsed.success && parsed.data.split_max_chars).toBe(240);
  });

  it("cai nos defaults da migration 0059 quando omitido", () => {
    const parsed = versionCreateSchema.safeParse(base);
    expect(parsed.success && parsed.data.split_messages).toBe(false);
    expect(parsed.success && parsed.data.split_max_chars).toBe(600);
  });

  it("aceita rascunho sem canal — channel_session_id nulo", () => {
    const parsed = versionCreateSchema.safeParse({ ...base, channel_session_id: null });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.channel_session_id).toBeNull();
  });
});
