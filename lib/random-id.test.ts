import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { randomId } from "./random-id";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Achado nº 9 (VPS): crypto.randomUUID não existe em http://IP (non-secure context). */
describe("randomId — UUID v4 dentro E fora de secure context", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("com crypto.randomUUID disponível → delega", () => {
    expect(randomId()).toMatch(UUID_V4);
  });

  it("SEM crypto.randomUUID (contexto não-seguro) → v4 válido via getRandomValues", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: crypto.getRandomValues.bind(crypto),
      // randomUUID ausente — exatamente o browser em http://IP
    });
    for (let i = 0; i < 50; i++) expect(randomId()).toMatch(UUID_V4);
  });

  /**
   * Régua anti-regressão: código que chega ao NAVEGADOR não pode chamar
   * crypto.randomUUID() cru — em http://IP isso é TypeError.
   *
   * A versão anterior só olhava arquivos com "use client" no topo, e por isso
   * não viu `lib/video/jitsi.ts` (#2441): um módulo de `lib/` sem o marcador,
   * importado pelo botão de vídeo. O critério agora é o inverso: TODO arquivo
   * de app/components/hooks/lib que chama crypto.randomUUID() é suspeito, e só
   * escapa quem está provadamente do lado do servidor — `app/api/**` (rota não
   * vai ao bundle) ou a lista abaixo, cada um com o motivo escrito.
   */
  const SO_SERVIDOR: Record<string, string> = {
    "lib/random-id.ts": "é o próprio helper: só delega quando randomUUID existe",
    "lib/agent-engine/edge/crm/send-ledger.ts":
      "importa node:crypto; roda no worker do agente e nas rotas de envio",
    "lib/agent-engine/flywheel/live.ts": "importa pg; só o workers/agent-worker usa",
    "lib/branding/logo.ts":
      "o módulo vai ao bundle (CampoDeLogo importa TAMANHO_MAXIMO_DO_LOGO), mas caminhoNovoDoLogo só é chamado em app/api/v1/marca/logo",
    "lib/channels/nome-da-sessao.ts":
      "nomeDaSessaoNovo só é chamado em lib/channels/connect-*, que cria a sessão pelo servidor",
    "lib/followup/nome-da-copia.ts":
      "nomeDaCopia só é chamado em app/api/v1/ai/followup-flows/[id]/duplicate",
    "lib/schemas/_validate.ts": "validação de body das rotas de app/api",
  };

  it("nenhum arquivo que chega ao navegador usa crypto.randomUUID cru", () => {
    const root = join(__dirname, "..");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === ".next" || name.startsWith(".")) continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
          walk(p);
        } else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) {
          const rel = relative(root, p).split(sep).join("/");
          if (rel.startsWith("app/api/") || rel in SO_SERVIDOR) continue;
          if (/crypto\.randomUUID\(/.test(readFileSync(p, "utf8"))) offenders.push(rel);
        }
      }
    };
    for (const d of ["app", "components", "hooks", "lib"]) walk(join(root, d));
    expect(offenders, "use randomId() de lib/random-id.ts").toEqual([]);
  });

  it("a lista de só-servidor não guarda arquivo que já não chama randomUUID", () => {
    // Sem isto a lista só cresce: quem troca para randomId() deixa a isenção
    // para trás, e um uso novo no mesmo arquivo passaria calado.
    const root = join(__dirname, "..");
    const mortos = Object.keys(SO_SERVIDOR).filter(
      (rel) => !/crypto\.randomUUID\(/.test(readFileSync(join(root, rel), "utf8")),
    );
    expect(mortos).toEqual([]);
  });
});
