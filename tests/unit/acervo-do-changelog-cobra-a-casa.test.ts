import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  candidataDoAcervo,
  candidatasDoPr,
  medir,
  tetoDoAgente,
  vereditoDoAcervo,
  type Medida,
} from "@/lib/release/cabe-na-tela";
import type { Fragmento } from "@/lib/release/fragmento";

/**
 * A MEDIÇÃO DO ACERVO SAIU DO PR — ELA NÃO PODE TER SUMIDO DE TODO LUGAR.
 *
 * Em 20/09/2026 os PRs #1377 (@lucasa15) e #1363 ficaram vermelhos no `verify`
 * — status check OBRIGATÓRIO — por `A seção termina no byte 32686`: os 43
 * fragmentos acumulados em `.changes/` produziriam uma seção maior do que o
 * `head -c 30000` do `agent.sh` manda para a VPS. Nenhum dos dois PRs tocava
 * `.changes/`. A mensagem mandava o contribuidor "enxugar o corpo dos
 * fragmentos", trabalho que não era dele, e o vermelho sumiu sozinho quando a
 * release 1.41.0 consumiu os fragmentos.
 *
 * O conserto foi tirar essa candidata do caminho do PR e cobrá-la onde quem a
 * vê pode pagá-la: o passo do `ci.yml` fora de `pull_request`, que chama
 * `pnpm release:acervo-cabe`.
 *
 * ⚠️ E AÍ MORA O RISCO QUE ESTE ARQUIVO FECHA. Trocar um vermelho injusto por
 * um SILÊNCIO seria pior que o defeito original: a degradação que a medição
 * vigia é real e datada (v1.4.0: 39.899 bytes contra teto de 30.000, com os
 * dois avisos de ação manual inteiros fora do corte). Um gate que fica verde
 * por não ter caso é o modo de falha mais silencioso que existe — e ele não se
 * denuncia sozinho.
 *
 * Então aqui se prova, sem depender do que houver em `.changes/` hoje:
 *
 *   1. a régua continua VIVA — acervo sintético que estoura REPROVA, nas três
 *      dimensões (bytes, histórico que alcança a instalada, aviso que sobrevive);
 *   2. a régua continua LIGADA — o alias existe, o script existe, e o `ci.yml`
 *      o invoca fora de `pull_request`;
 *   3. a régua continua FORA DO PR — nem o caminho do PR a carrega de volta.
 */

const RAIZ = process.cwd();
const RAW = fs.readFileSync(path.join(RAIZ, "CHANGELOG.md"), "utf8");
const AGENT_SH = fs.readFileSync(path.join(RAIZ, "hostgator-setup-kit", "agent.sh"), "utf8");
const CI = fs.readFileSync(path.join(RAIZ, ".github/workflows/ci.yml"), "utf8");
const PKG = JSON.parse(fs.readFileSync(path.join(RAIZ, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};
const TETO = tetoDoAgente(AGENT_SH);

/** Um fragmento de tamanho controlado — `x` é ASCII, então 1 char = 1 byte. */
function sintetico(bytesDeCorpo: number, atencao: string | null = null): Fragmento {
  return {
    arquivo: "sintetico.md",
    impacto: atencao === null ? "nada_mudou" : "exige_acao",
    secao: "corrigido",
    titulo: "fragmento sintético",
    corpo: "x".repeat(Math.max(1, bytesDeCorpo)),
    atencao,
  };
}

function medirAcervo(bytesDeCorpo: number, atencao: string | null = null): Medida {
  const candidata = candidataDoAcervo(RAW, [sintetico(bytesDeCorpo, atencao)]);
  expect(candidata, "candidataDoAcervo devolveu null com fragmento na mão").not.toBeNull();
  return medir(candidata!, AGENT_SH);
}

/**
 * O tamanho de corpo que faz a seção terminar EXATAMENTE no byte `alvo`.
 *
 * `fim` é linear no corpo (um `x` a mais é um byte a mais na seção), então
 * duas medições bastam — e isso é mais honesto que varrer um intervalo: quem
 * varre acha o caso por sorte e não sabe dizer qual byte mediu.
 */
function corpoParaTerminarEm(alvo: number): number {
  const base = 1000;
  const fimBase = medirAcervo(base).fim;
  return base + (alvo - fimBase);
}

describe("a medição do acervo de .changes/ saiu do PR e continua viva", () => {
  describe("1. a régua continua VIVA", () => {
    it("controle positivo: acervo pequeno passa, sem aviso", () => {
      const m = medirAcervo(corpoParaTerminarEm(TETO - 20_000));
      expect(m.cabe).toBe(true);
      expect(m.completa, "sem `completa` a segunda régua não está sendo exercida").toBe(true);
      const v = vereditoDoAcervo(m);
      expect(v.reprova).toBe(false);
      expect(v.avisa, `folga ${m.folga} B contra seção de ${m.tamanhoDaSecao} B`).toBe(false);
    });

    it("acervo que passa do teto REPROVA — é o defeito de 20/09 com o ator certo", () => {
      const m = medirAcervo(corpoParaTerminarEm(TETO + 2_686));
      expect(m.cabe, `fim ${m.fim} contra teto ${m.teto}`).toBe(false);
      expect(vereditoDoAcervo(m).reprova).toBe(true);
    });

    it("a faixa cega também reprova: cabe em bytes e o histórico NÃO alcança a instalada", () => {
      // O que o agente manda vai ALÉM do fim da seção — até o cabeçalho da
      // versão instalada, inclusive, que é quem faz `completa` ser `true`.
      // Terminando a seção no último byte do teto, esse cabeçalho não entra.
      const m = medirAcervo(corpoParaTerminarEm(TETO));
      expect(m.cabe, "controle: este caso só vale se a conta de bytes PASSAR").toBe(true);
      expect(m.completa, "a segunda régua morreu: só a conta de bytes sobrou").toBe(false);
      expect(vereditoDoAcervo(m).reprova).toBe(true);
    });

    it("a terceira régua está ligada: o aviso de ação manual é medido, e sobrevive ao corte", () => {
      // `montarSecao` põe `### ⚠️ Requer atenção` logo depois do cabeçalho
      // justamente para o aviso sobreviver ao corte. O que se cobra aqui é que
      // a régua seja EXERCIDA (não-nula) e dê o resultado que o desenho promete.
      const m = medirAcervo(2_000, "Rode `docker compose pull` antes de subir.");
      expect(m.avisoSobrevive, "a régua do aviso não foi exercida: veio `null` com bloco presente").not.toBeNull();
      expect(m.avisoSobrevive).toBe(true);
    });
  });

  describe("2. o aviso antecipado tem régua DERIVADA, nunca digitada", () => {
    // A régua é o tamanho da própria seção que o acervo produz: "dobrar este
    // acervo não caberia". Ela dispara por volta da metade do que cabe — folga
    // que ainda dá para cortar release com calma —, cresce junto com o texto e
    // some sozinha quando `.changes/` esvazia.
    it("avisa quando outro ciclo do tamanho deste não caberia", () => {
      const m = medirAcervo(corpoParaTerminarEm(TETO - 5_000));
      expect(m.cabe).toBe(true);
      expect(m.tamanhoDaSecao).toBeGreaterThan(m.folga);
      expect(vereditoDoAcervo(m).avisa).toBe(true);
    });

    it("a régua é o acervo, e só ele: nenhum número constante decide o aviso", () => {
      // Direto sobre a regra, com números que não existem em lugar nenhum do
      // repositório — se alguém trocar a derivação por um limiar digitado,
      // estes dois casos param de se comportar como espelho um do outro.
      const base: Medida = {
        nome: "sintética",
        conserto: "",
        teto: 1_000,
        fim: 900,
        folga: 100,
        tamanhoDaSecao: 101,
        cabe: true,
        completa: true,
        avisoSobrevive: null,
      };
      expect(vereditoDoAcervo(base).avisa, "folga 100 < seção 101: dobrar estoura").toBe(true);
      expect(
        vereditoDoAcervo({ ...base, tamanhoDaSecao: 99 }).avisa,
        "folga 100 > seção 99: dobrar ainda cabe",
      ).toBe(false);
    });

    it("quem já reprovou não recebe aviso — o vermelho não vira amarelo", () => {
      const m = medirAcervo(corpoParaTerminarEm(TETO + 1_000));
      const v = vereditoDoAcervo(m);
      expect(v.reprova).toBe(true);
      expect(v.avisa).toBe(false);
    });
  });

  describe("3. a régua continua LIGADA no CI, fora de pull_request", () => {
    const verify = (() => {
      const inicio = CI.indexOf("\n  verify-parte:\n");
      expect(inicio, "o job verify-parte sumiu do ci.yml").toBeGreaterThan(-1);
      const resto = CI.slice(inicio + 1);
      const fim = resto.slice(1).search(/\n {2}[a-zA-Z0-9_-]+:\n/);
      return fim < 0 ? resto : resto.slice(0, fim + 1);
    })();

    it("controle positivo: o recorte pegou o job que roda a suíte", () => {
      expect(verify).toContain("pnpm test:unit");
      expect(verify.length).toBeGreaterThan(500);
    });

    it("o alias existe no package.json e aponta para o script", () => {
      // O elo que uma sonda por nome de ARQUIVO não atravessa: é ele que liga o
      // nome usado no workflow ao arquivo de verdade.
      expect(PKG.scripts["release:acervo-cabe"]).toMatch(/scripts\/acervo-cabe-na-tela\.ts/);
    });

    it("o script existe em disco", () => {
      expect(fs.existsSync(path.join(RAIZ, "scripts/acervo-cabe-na-tela.ts"))).toBe(true);
    });

    it("o verify invoca a guarda por QUALQUER um dos dois nomes", () => {
      const invoca =
        /pnpm release:acervo-cabe/.test(verify) || /tsx scripts\/acervo-cabe-na-tela\.ts/.test(verify);
      expect(
        invoca,
        "nenhum passo do verify-parte chama a medição do acervo: ela saiu do PR e não ficou em lugar nenhum",
      ).toBe(true);
    });

    it("e a invoca FORA de pull_request — é lá que quem vê o vermelho pode cortar release", () => {
      const i = verify.search(/- name: O acervo de \.changes\/ cabe na tela da VPS\?/);
      expect(i, "o passo do acervo sumiu ou foi renomeado").toBeGreaterThan(-1);
      const passo = verify.slice(i, i + 400);
      expect(
        passo.match(/^\s+if: (.*)$/m)?.[1],
        "em pull_request o autor não pode pagar esta dívida; fora dele, quem a vê corta release",
      ).toBe("matrix.parte == 1 && github.event_name != 'pull_request'");
    });
  });

  describe("4. a régua continua FORA do caminho do PR", () => {
    it("nenhuma candidata do PR é a do acervo", () => {
      const nomes = candidatasDoPr(RAW).map((c) => c.nome);
      expect(nomes.length, "controle: o caminho do PR ficou sem candidata nenhuma").toBeGreaterThan(0);
      for (const nome of nomes) {
        expect(nome, `a candidata do acervo voltou ao caminho do PR: ${nome}`).not.toMatch(/\.changes/);
      }
    });

    it("o teste que roda em pull_request não importa a candidata do acervo", () => {
      // A regressão natural é alguém "completar" o teste do PR somando a
      // terceira candidata de volta. Ela tem de entrar por aqui, não por lá.
      const doPr = fs.readFileSync(path.join(RAIZ, "tests/unit/changelog-cabe-na-tela-da-vps.test.ts"), "utf8");
      expect(
        doPr,
        "o teste do PR voltou a medir o acervo — é o vermelho que o autor não pode consertar",
      ).not.toMatch(/candidataDoAcervo/);
    });
  });
});
