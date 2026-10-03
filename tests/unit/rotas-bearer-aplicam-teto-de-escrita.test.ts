import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * TETO DE ESCRITA: toda rota que chama `resolveAuthDual` PRECISA chamar
 * `tetoDeEscritaDoToken` E devolver a resposta dele (#1999).
 *
 * Quando a rota está em `PUBLIC_PATHS`, o `proxy.ts` não decide sobre ela, e
 * nada a montante conta as chamadas: o que não for contado na rota não é
 * contado em lugar nenhum (`lib/api/auth-dual.ts`, `tetoDeEscritaDoToken`).
 *
 * Nem toda rota que chama `resolveAuthDual` aceita Bearer HOJE: sem entrada em
 * `PUBLIC_PATHS`, o proxy devolve 401 a Bearer sem cookie antes do handler.
 * Era o caso de `drafts/consume` e `notes/media` quando a #1999 foi aberta —
 * nelas o teto é defesa em profundidade, e passa a valer no dia em que
 * entrarem na lista. A varredura cobra o teto de todas, sem distinção: quem
 * acrescenta a entrada em `PUBLIC_PATHS` não precisa lembrar do teto.
 *
 * A varredura é VIVA: lê toda `route.ts` de `app/api/v1/`. Rota nova que chame
 * `resolveAuthDual` sem o teto reprova aqui. O par chamada + `return` é cobrado
 * junto, porque sem o `if (teto) return teto;` a chamada só conta e não barra
 * — e essa perda passaria calada por uma varredura que olhasse só a chamada.
 * O comportamento (429 de verdade) está provado em
 * `app/api/v1/conversations/[id]/media/route.test.ts`.
 */
const RAIZ = process.cwd();
const BASE = path.join(RAIZ, "app/api/v1");

/**
 * Rotas que chamam `resolveAuthDual` e aplicam o teto por outro caminho. Cada
 * entrada precisa de motivo escrito.
 */
const TETO_POR_OUTRO_CAMINHO: Record<string, string> = {
  // #1491: o teto de `/messages` nasceu antes do helper e chama `checkRateLimit`
  // direto, com os mesmos números (por token e por organização).
  "app/api/v1/messages/route.ts": "checkRateLimit",
};

// O que se cobra é o PAR chamada + `return`, não o nome das variáveis: a
// `prospecting` chama o resultado do `resolveAuthDual` de `auth`, e a
// `agenda/tipos` passa `requestId ?? ""`. As duas aplicam o teto; exigir
// `authz`/`requestId` literais reprovava a main com as duas rotas certas.
const CHAMADA_COM_RETURN =
  /const (\w+) = await tetoDeEscritaDoToken\(\w+, "[^"]+", [^;]+\);\s*if \(\1\) return \1;/;

const rotasBearer = (readdirSync(BASE, { recursive: true }) as string[])
  .filter((rel) => path.basename(rel) === "route.ts")
  .map((rel) => path.posix.join("app/api/v1", rel.split(path.sep).join("/")))
  .filter((rel) => readFileSync(path.join(RAIZ, rel), "utf8").includes("resolveAuthDual("))
  .sort();

describe("rotas com resolveAuthDual aplicam teto de escrita", () => {
  it("a varredura acha as rotas (controle de vacuidade)", () => {
    // Piso, não igualdade: 8 é quantas existiam quando o teste nasceu. Rota
    // nova não deve exigir editar este número.
    expect(rotasBearer.length).toBeGreaterThanOrEqual(8);
  });

  it.each(rotasBearer.filter((rel) => !(rel in TETO_POR_OUTRO_CAMINHO)))(
    "%s chama tetoDeEscritaDoToken e devolve a resposta dele",
    (rel) => {
      const fonte = readFileSync(path.join(RAIZ, rel), "utf8");
      expect(fonte, `${rel}: falta \`const x = await tetoDeEscritaDoToken(...); if (x) return x;\``).toMatch(
        CHAMADA_COM_RETURN,
      );
    },
  );

  it.each(Object.entries(TETO_POR_OUTRO_CAMINHO))(
    "%s está na allowlist e ainda usa %s",
    (rel, marca) => {
      expect(rotasBearer, `${rel} saiu da varredura: tire-o da allowlist`).toContain(rel);
      expect(readFileSync(path.join(RAIZ, rel), "utf8")).toContain(`await ${marca}(`);
    },
  );
});
