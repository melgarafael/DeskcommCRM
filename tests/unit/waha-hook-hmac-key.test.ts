import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * O WAHA só assina o webhook sob o nome EXATO da doc dele
 * (events#hmac-authentication): `WHATSAPP_HOOK_HMAC_KEY`.
 *
 * ── Por que este arquivo existe ─────────────────────────────────────────────
 *
 * Os três composes entregavam o segredo em `WHATSAPP_HOOK_HMAC` — nome que não
 * existe na doc do WAHA. Ele ignorava em silêncio e nunca assinava nada; com
 * "Exigir assinatura nas entregas do canal" ligado, toda entrega caía em 401
 * `signature_required` e nenhuma mensagem entrava. Medido na VPS em 2026-10-04:
 * 3692 entregas em 7 dias, zero assinadas, com os segredos iguais e válidos
 * (64 chars) dos dois lados. A troca de UMA palavra (`_KEY`) no compose religa
 * a verificação inteira — e nada neste repositório a vigiava.
 *
 * Sem shell, sem docker: só lê arquivo. Roda no Windows e no CI.
 */

const RAIZ = process.cwd();

const COMPOSES = ["docker-compose.yml", "docker-compose.prod.yml", "docker-compose.local.yml"] as const;

/** Linhas que DECLARAM variável (chave YAML), ignorando comentário e prosa. */
function chavesDeHook(texto: string): string[] {
  return texto
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("WHATSAPP_HOOK_HMAC"))
    .map((l) => l.split(":")[0]!.trim());
}

describe("o WAHA recebe o segredo sob o nome que ele documenta", () => {
  it.each([...COMPOSES])("`%s` entrega em WHATSAPP_HOOK_HMAC_KEY", (arquivo) => {
    const texto = fs.readFileSync(path.join(RAIZ, arquivo), "utf8");
    const chaves = chavesDeHook(texto);
    expect(chaves.length, `nenhuma chave WHATSAPP_HOOK_HMAC* declarada em ${arquivo}`).toBeGreaterThan(0);
    expect(
      chaves,
      `${arquivo} declara ${chaves.join(", ")} — o WAHA só assina sob WHATSAPP_HOOK_HMAC_KEY`,
    ).toEqual(chaves.map(() => "WHATSAPP_HOOK_HMAC_KEY"));
  });

  it("o valor entregue é o segredo que o app confere (WAHA_HMAC_SECRET)", () => {
    // A âncora cruzada: o compose e o schema do app precisam falar do MESMO
    // segredo. Se um lado renomear o dele, o outro continua verde sozinho e a
    // verificação quebra em silêncio — exatamente a família deste defeito.
    const env = fs.readFileSync(path.join(RAIZ, "lib/env.ts"), "utf8");
    expect(env).toMatch(/^  WAHA_HMAC_SECRET:/m);
    for (const arquivo of COMPOSES) {
      const texto = fs.readFileSync(path.join(RAIZ, arquivo), "utf8");
      expect(
        texto,
        `${arquivo} não interpola \${WAHA_HMAC_SECRET} na chave do HMAC`,
      ).toContain("WHATSAPP_HOOK_HMAC_KEY: ${WAHA_HMAC_SECRET}");
    }
  });
});
