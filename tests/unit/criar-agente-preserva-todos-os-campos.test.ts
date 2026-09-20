/**
 * Achado 3b da investigação de 20/09/2026: criar um agent pela tela (ou pela rota
 * REST) grava a v1 com `.insert({...})` escrito à mão, uma cópia paralela às
 * colunas de `VERSION_COLUMNS` (essa já vigiada por
 * `agent-version-columns-drift.test.ts`). As duas cópias de INSERT ficaram para
 * trás quando o papel Operador e os funis (spec 16/17) entraram: quem configurava
 * operador, follow-up ou um funil NA TELA DE CRIAÇÃO via tudo desligado na v1,
 * em silêncio — o toast dizia "Agent criado".
 *
 * Este teste força as duas cópias de INSERT a mencionar `v.<campo>` para todo
 * campo do formulário (`versionShapeSchema`, exceto os que o próprio código trata
 * fora do literal, como `trigger_config`, tratado logo abaixo por nome).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { versionCreateSchema } from "@/lib/ai/agents/validation";

const ROOT = process.cwd();

const FILES_QUE_CRIAM_A_V1 = [
  "app/app/ai/agents/[id]/_actions.ts",
  "app/api/v1/ai/agents/route.ts",
];

/** Campos que o literal não grava por nome (tratamento especial já coberto). */
const FORA_DO_LITERAL = new Set(["trigger_config"]);

/** Extrai o objeto passado a `.insert({...})` para `ai_agent_versions` por contagem de chaves. */
function insertLiteralDeVersao(relPath: string): string {
  const source = readFileSync(join(ROOT, relPath), "utf8");
  const marcador = source.indexOf('from("ai_agent_versions")');
  if (marcador === -1) throw new Error(`"ai_agent_versions" não encontrado em ${relPath}`);
  const inicioInsert = source.indexOf(".insert({", marcador);
  if (inicioInsert === -1) throw new Error(`.insert({ não encontrado após ai_agent_versions em ${relPath}`);
  const inicioChaves = source.indexOf("{", inicioInsert);
  let profundidade = 0;
  for (let i = inicioChaves; i < source.length; i++) {
    if (source[i] === "{") profundidade++;
    if (source[i] === "}") {
      profundidade--;
      if (profundidade === 0) return source.slice(inicioChaves, i + 1);
    }
  }
  throw new Error(`chave de fechamento do .insert não encontrada em ${relPath}`);
}

describe("criação de agent (v1) grava todos os campos do formulário", () => {
  const camposDoFormulario = Object.keys(versionCreateSchema.shape).filter(
    (c) => !FORA_DO_LITERAL.has(c),
  );

  it("a lista de campos esperada não está vazia (sanity do próprio teste)", () => {
    expect(camposDoFormulario.length).toBeGreaterThan(10);
  });

  for (const file of FILES_QUE_CRIAM_A_V1) {
    it(`${file} grava \`v.<campo>\` para cada campo de versionCreateSchema`, () => {
      const literal = insertLiteralDeVersao(file);
      const faltando = camposDoFormulario.filter(
        (campo) => !new RegExp(`\\bv\\.${campo}\\b`).test(literal),
      );
      expect(faltando).toEqual([]);
    });
  }
});
