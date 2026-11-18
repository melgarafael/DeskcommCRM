import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Toda rota de upload lê o corpo por `lerCorpoComTeto` (lib/api/corpo-com-teto.ts),
 * e nunca direto da Request. Conferir só o `content-length` declarado e depois
 * chamar `req.formData()` deixava o envio sem tamanho declarado ser lido inteiro
 * para a memória. O comportamento do helper é provado em lib/api/corpo-com-teto.test.ts;
 * aqui, que cada rota passa por ele antes de qualquer leitura.
 */
const ROTAS = [
  "products/[id]/ai-presentation/audio",
  "products/[id]/fotos",
  "conversations/[id]/media",
  "conversations/[id]/notes/media",
  "message-templates/[id]/midias",
  "settings/sons",
  "ai/skills/import",
  "prospecting/importar",
  "ai/knowledge/sources/upload",
  "contacts/import",
  "imports",
  "leads/[id]/attachments",
  "leads/import",
  "marca/logo",
  "products/import",
  "settings/proposal-templates/importar",
  "message-templates/importar",
  "ai/followup-flows/import",
];

describe("rotas de upload leem o corpo pelo teto", () => {
  it.each(ROTAS)("%s", (rota) => {
    const fonte = readFileSync(join(process.cwd(), "app/api/v1", rota, "route.ts"), "utf8");
    const post = fonte.slice(fonte.indexOf("export async function POST"));
    const teto = post.search(/lerCorpoComTeto\((req|request),/);
    const leitura = post.search(/\.(formData|text)\(\)/);
    expect(teto).toBeGreaterThan(-1);
    expect(leitura).toBeGreaterThan(teto);
    expect(post).not.toMatch(/\b(req|request)\.(formData|text|arrayBuffer|blob)\(\)/);
    expect(post).not.toMatch(/headers\.get\("content-length"\)/);
  });
});
