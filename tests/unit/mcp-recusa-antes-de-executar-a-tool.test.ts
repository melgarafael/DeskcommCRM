import { describe, expect, it } from "vitest";

import { arquivosDeCodigo, caminhoRelativo } from "./helpers/varrer-codigo";
import { readFileSync } from "node:fs";

/**
 * S7 — A RECUSA POR TETO ACONTECE ANTES DE A TOOL RODAR.
 *
 * ─── Por que isto é um teste separado, e por que importa tanto ──────────────
 * Um teto que recusa DEPOIS do efeito não é teto: é um log. Entre as 63 tools
 * do MCP há `crm_send_whatsapp_message`, e o canal por QR (WAHA) é cliente
 * não-oficial do WhatsApp — que restringe e bane por VOLUME, e bane o NÚMERO,
 * não a sessão. Se a verificação do teto rodasse depois do handler, um agente
 * de terceiro em laço mandaria as mensagens e SÓ ENTÃO seria barrado. O dano
 * já estaria feito, e não há desfazer em WhatsApp.
 *
 * ─── O que se mede ──────────────────────────────────────────────────────────
 * A ORDEM no `server.ts`: `verificarTetoMcp` tem de aparecer antes de
 * `tool.handler(`. Estática porque a ordem É a garantia — um dublê que
 * afirmasse "o handler não foi chamado" provaria o mesmo com mais peças, e
 * continuaria cego se alguém movesse a linha para depois.
 *
 * Mede também que o teto é cobrado DENTRO do `try`: fora dele, a recusa não
 * passaria pelo `catch` que audita, e `api_audit_log` não teria rastro nenhum
 * de por que o agente parou.
 */
const SERVER = "lib/mcp/server.ts";

function fonteDo(caminho: string): string {
  const alvo = arquivosDeCodigo(["lib/mcp"]).find((a) => caminhoRelativo(a) === caminho);
  if (!alvo) throw new Error(`não achei ${caminho} — a varredura mudou de forma`);
  return readFileSync(alvo, "utf8");
}

const FONTE = fonteDo(SERVER);

describe("teto do MCP é cobrado antes do efeito", () => {
  it("enxerga o arquivo que varre — varredura que não acha nada não olhou", () => {
    expect(FONTE).toContain("createMcpServer");
    expect(FONTE).toContain("tool.handler(");
  });

  it("S7 — verificarTetoMcp vem ANTES de tool.handler", () => {
    const teto = FONTE.indexOf("verificarTetoMcp(");
    const handler = FONTE.indexOf("tool.handler(");

    expect(teto, "verificarTetoMcp não é chamado em server.ts").toBeGreaterThan(-1);
    expect(teto).toBeLessThan(handler);
  });

  it("o teto é cobrado antes também de escopo e papel", () => {
    const teto = FONTE.indexOf("verificarTetoMcp(");
    expect(teto).toBeLessThan(FONTE.indexOf("ensureScope("));
    expect(teto).toBeLessThan(FONTE.indexOf("ensureRole("));
  });

  it("a recusa passa pelo catch que audita — o teto é cobrado DENTRO do try", () => {
    const try_ = FONTE.indexOf("try {");
    const teto = FONTE.indexOf("verificarTetoMcp(");
    const catch_ = FONTE.indexOf("} catch (err)");

    expect(try_).toBeGreaterThan(-1);
    expect(teto).toBeGreaterThan(try_);
    expect(teto).toBeLessThan(catch_);
    // E o `catch` audita: sem isto, recusa silenciosa.
    expect(FONTE.slice(catch_)).toContain("auditMcpToolCall");
  });
});
