/**
 * O ROTEIRO DO KIT E O GUIA DE INSTALAÇÃO CONTAM A MESMA HISTÓRIA.
 *
 * `hostgator-setup-kit/CLAUDE.md` é o que o Claude Code lê quando a pessoa
 * "joga a pasta no chat" numa VPS sem clone; `.agents/skills/deskcomm-instalar/`
 * é o guia completo, embutido no repositório para os cinco CLIs. Dois textos
 * sobre a mesma instalação envelhecem em ritmos diferentes — e foi medido: em
 * 2026-09-08 o roteiro do kit estava errado em quatro pontos (MFA obrigatório,
 * só Anthropic, sem token do Supabase, `--yes` com o .env do exemplo), enquanto
 * o `install.sh` já fazia o certo há semanas.
 *
 * Este arquivo prende (a) o ponteiro do roteiro para o guia, (b) as frases que
 * salvam instalação nos DOIS lugares, e (c) a ausência das afirmações vencidas —
 * inclusive no banner final do próprio `install.sh`, que repetia o erro do MFA.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = process.cwd();
const ler = (p: string) => readFileSync(join(RAIZ, p), "utf8");

const ROTEIRO = ler("hostgator-setup-kit/CLAUDE.md");
const GUIA = ler(".agents/skills/deskcomm-instalar/SKILL.md");
const REFERENCIAS = [
  "o-que-a-instalacao-pede",
  "problemas-e-armadilhas",
  "scripts-do-kit",
  "dominio-e-dns",
  "supabase",
  "agencia",
].map((n) => ler(`.agents/skills/deskcomm-instalar/references/${n}.md`));
const GUIA_INTEIRO = [GUIA, ...REFERENCIAS].join("\n");
const INSTALL = ler("hostgator-setup-kit/install.sh");

/** As frases que, faltando, custam uma instalação inteira. */
const FRASES_QUE_SALVAM = [
  "Session pooler", // a connection string certa (a Direct é só IPv6)
  "registro A", // o DNS que o cadeado exige
  "SUPABASE_ACCESS_TOKEN", // o caminho que configura os links dos e-mails
  "OpenRouter", // os três provedores, não só a Anthropic
  "SENTRY_DSN=off", // telemetria com consentimento (issue #668)
];

/** Afirmações que já foram verdade e o código contradiz hoje. */
const FRASES_VENCIDAS = [
  "no primeiro login o CRM pede", // MFA deixou de ser forçado
  "pede a verificação em duas etapas", // idem, no banner do install.sh
  "por padrão os erros desta instalação são enviados", // a pergunta tem padrão NÃO enviar
];

describe("roteiro do kit × guia de instalação", () => {
  it("o roteiro aponta para o guia embutido", () => {
    expect(ROTEIRO).toContain(".agents/skills/deskcomm-instalar/SKILL.md");
  });

  it.each(FRASES_QUE_SALVAM)("a frase %j está no roteiro E no guia", (frase) => {
    expect(ROTEIRO, `roteiro do kit sem: ${frase}`).toContain(frase);
    expect(GUIA_INTEIRO, `guia sem: ${frase}`).toContain(frase);
  });

  it("os dois dizem que a verificação em duas etapas é opcional", () => {
    expect(ROTEIRO).toMatch(/duas etapas é opcional/i);
    expect(GUIA).toMatch(/duas etapas é opcional/i);
  });

  it.each(FRASES_VENCIDAS)("a afirmação vencida %j não sobreviveu em lugar nenhum", (frase) => {
    for (const [nome, texto] of [
      ["hostgator-setup-kit/CLAUDE.md", ROTEIRO],
      ["deskcomm-instalar", GUIA_INTEIRO],
      ["hostgator-setup-kit/install.sh", INSTALL],
    ] as const) {
      const linhasQueAfirmam = texto
        .split("\n")
        // Citar o erro passado ("o banner dizia…") é permitido; afirmar, não.
        .filter((l) => l.includes(frase) && !/dizia|era a regra|mediu|afirmava/.test(l));
      expect(linhasQueAfirmam, `${nome} ainda afirma: ${frase}`).toEqual([]);
    }
  });

  it("o banner final do install.sh reflete a escolha de telemetria em vez de afirmar um padrão", () => {
    expect(INSTALL).toContain("telemetria_no_banner()");
    expect(INSTALL).toMatch(/if \[ "\$\{SENTRY_DSN:-\}" = "off" \]/);
  });
});
