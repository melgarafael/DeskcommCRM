/**
 * O MAPA DA SKILL ACOMPANHA O MENU — E A BUSCA PERGUNTA NA HORA.
 *
 * A skill deskcomm-operacao ensinava só parte das telas do menu porque
 * nada comparava o menu (lib/navigation/catalogo.ts) com o mapa dela. O script
 * scripts/conferir-mapa.sh faz essa comparação e AVISA (nunca reprova); o
 * scripts/buscar.sh lista o menu e procura nele, no CHANGELOG e na skill.
 *
 * ## Os defeitos que este arquivo existe para pegar
 *
 * 1. **Menu que cresce e mapa que não acompanha.** O caso 2 é a própria
 *    sabotagem: mapa incompleto → aviso com label e href; o caso 3 prova que,
 *    sem a falta, não há aviso.
 * 2. **`--menu` que conta hub como tela.** Os hubs de NAV_GROUPS têm `href`
 *    na mesma linha (`hub: { href: ...`), nunca em linha própria de 4
 *    espaços — a mesma régua que o caso 1 mede dos dois lados.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = process.cwd();
const SKILL = join(RAIZ, ".agents/skills/deskcomm-operacao");
const BUSCAR = join(SKILL, "scripts/buscar.sh");
const CONFERIR = join(SKILL, "scripts/conferir-mapa.sh");
const CATALOGO = readFileSync(join(RAIZ, "lib/navigation/catalogo.ts"), "utf8");

const temBash = ((): boolean => {
  try {
    execFileSync("bash", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

function roda(script: string, args: string[], raiz: string): { saida: string; rc: number } {
  try {
    const saida = execFileSync("bash", [script, ...args], {
      cwd: raiz,
      encoding: "utf8",
      env: { ...process.env, DESKCOMM_REPO: raiz },
    });
    return { saida, rc: 0 };
  } catch (erro: unknown) {
    const status = (erro as { status?: unknown }).status;
    const stdout = (erro as { stdout?: unknown }).stdout;
    expect(typeof status, "bash saiu sem código").toBe("number");
    return { saida: typeof stdout === "string" ? stdout : "", rc: status as number };
  }
}

/** Monta raiz mínima: catalogo.ts com 3 telas + mapa citando as indicadas. */
function raizFalsa(citadas: string[], nomes: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "mapa-"));
  mkdirSync(join(dir, "lib/navigation"), { recursive: true });
  mkdirSync(join(dir, ".agents/skills/deskcomm-operacao/references"), { recursive: true });
  const telas = [
    { href: "/app/inbox", label: "Inbox" },
    { href: "/app/radar", label: "Radar" },
    { href: "/app/agenda", label: "Agenda" },
  ];
  const catalogo =
    "export const NAV_CATALOG = [\n" +
    telas.map((t) => `  {\n    href: "${t.href}",\n    label: "${t.label}",\n    group: "atendimento",\n  },`).join("\n") +
    "\n];\n";
  writeFileSync(join(dir, "lib/navigation/catalogo.ts"), catalogo);
  const mapa =
    "# Mapa\n\n" +
    citadas
      .map((h) => `| ${nomes[h] ?? telas.find((x) => x.href === h)?.label ?? "Tela"} | Caminho \`${h}\` |\n`)
      .join("") +
    "\n";
  writeFileSync(join(dir, ".agents/skills/deskcomm-operacao/references/mapa-da-interface.md"), mapa);
  return dir;
}

describe("skill-operacao — buscar.sh --menu conta as telas do catálogo", () => {
  it.skipIf(!temBash)("total bate com as entradas de NAV_CATALOG (4 espaços, sem hubs)", () => {
    const esperado = CATALOGO.split("\n").filter((l) => l.startsWith('    href: "/app')).length;
    expect(esperado).toBeGreaterThan(0);
    const { saida, rc } = roda(BUSCAR, ["--menu"], RAIZ);
    expect(rc).toBe(0);
    expect(saida).toContain(`total: ${esperado} telas`);
  });
});

describe("skill-operacao — conferir-mapa.sh avisa da tela que falta", () => {
  it.skipIf(!temBash)("mapa com 2 de 3: avisa a terceira por label e href, sai com 0", () => {
    const dir = raizFalsa(["/app/inbox", "/app/radar"]);
    const { saida, rc } = roda(CONFERIR, [], dir);
    expect(rc).toBe(0);
    expect(saida).toContain("Agenda (/app/agenda)");
    expect(saida).not.toContain("Radar (/app/radar)");
    expect(saida).toContain("1 fora do mapa");
  });

  it.skipIf(!temBash)("com --estrito a mesma falta sai com 1", () => {
    const dir = raizFalsa(["/app/inbox", "/app/radar"]);
    const { rc } = roda(CONFERIR, ["--estrito"], dir);
    expect(rc).toBe(1);
  });

  it.skipIf(!temBash)("tela renomeada no menu e não no mapa: avisa pelo nome novo, sai com 0", () => {
    const dir = raizFalsa(["/app/inbox", "/app/radar", "/app/agenda"], { "/app/radar": "Painel antigo" });
    const { saida, rc } = roda(CONFERIR, [], dir);
    expect(rc).toBe(0);
    expect(saida).toContain("renomeada");
    expect(saida).toContain("Radar (/app/radar)");
    expect(saida).not.toContain("Inbox (/app/inbox)");
  });

  it.skipIf(!temBash)("mapa completo: sai com 0 e imprime a linha de cobertura", () => {
    const dir = raizFalsa(["/app/inbox", "/app/radar", "/app/agenda"]);
    const { saida, rc } = roda(CONFERIR, [], dir);
    expect(rc).toBe(0);
    expect(saida).toContain("cobre as 3 telas do menu");
    expect(saida).not.toContain("fora do mapa");
  });
});
