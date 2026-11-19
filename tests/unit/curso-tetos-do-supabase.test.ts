// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { Modulo } from "../../curso/licao";

/**
 * A cerca que o curso NÃO tem, e esta tem: número de cota é rastreável à fonte.
 *
 * `curso/licoes.test.ts` confere o CONTRATO do módulo e que `tela` existe no
 * menu — ele não olha o texto de um passo. Medido em 17/11/2026: trocar um teto
 * citado por um número errado dentro de `curso/licoes/*.json` deixava a suíte
 * do curso inteira verde. O que chega ao aluno é prosa, e prosa não tinha gate.
 *
 * Aqui cada teto da aula "Quando o Supabase aperta" é um par: o trecho que a
 * AULA afirma e o trecho que o RUNBOOK de origem afirma. Um número trocado de
 * um lado só reprova, e a mensagem diz qual. Se o runbook mudar de número, este
 * teste reprova de propósito: a aula tem de ser reescrita junto, nunca ficar
 * ensinando o teto velho.
 *
 * A comparação ignora espaço em branco porque os runbooks quebram linha no meio
 * de uma frase — "~6 h" mora dentro de uma célula de tabela — e um gate que
 * reprova por quebra de linha ensina a relaxar o gate.
 */

const RAIZ = path.resolve(__dirname, "../..");
const AULA = "quando-o-supabase-aperta";
const MODULO = "curso/licoes/admin-sistema.json";
const COTA = "docs/runbooks/custo-e-cota-do-supabase.md";
const MEMORIA = "docs/runbooks/supabase-sem-memoria-no-free.md";
const SETUP = "docs/SETUP.md";

const normalizar = (texto: string) => texto.replace(/\s+/g, " ");

const ler = (relativo: string) => normalizar(fs.readFileSync(path.join(RAIZ, relativo), "utf8"));

type Teto = {
  /** O que a aula afirma — número e unidade, como o aluno lê. */
  naAula: string;
  /** O que a fonte afirma. */
  naFonte: string;
  fonte: string;
};

/** Um par por teto citado na aula. Sem entrada aqui, o teto não entra na aula. */
const TETOS: readonly Teto[] = [
  { naAula: "500 MB de banco", naFonte: "500 MB de banco", fonte: COTA },
  { naAula: "1 GB de storage", naFonte: "1 GB de storage", fonte: COTA },
  { naAula: "50 mil usuários ativos no mês", naFonte: "50 mil usuários ativos no mês", fonte: COTA },
  { naAula: "5 GB por mês de egress", naFonte: "5 GB/mês", fonte: COTA },
  { naAula: "1 GB de log ingerido por ciclo", naFonte: "1 GB de log ingerido por ciclo", fonte: COTA },
  { naAula: "50 MB por arquivo", naFonte: "50 MB por arquivo", fonte: COTA },
  { naAula: "413", naFonte: "413", fonte: COTA },
  { naAula: "Not billed", naFonte: "Not billed", fonte: COTA },
  { naAula: "início de 2027", naFonte: "início de 2027", fonte: COTA },
  { naAula: "3.880 consultas em 2h19", naFonte: "3.880 consultas em 2h19", fonte: COTA },
  { naAula: "60000", naFonte: "QUEUE_IDLE_MAX_INTERVAL_MS=60000", fonte: COTA },
  { naAula: "04h40", naFonte: "04h40", fonte: COTA },
  { naAula: "05h20", naFonte: "05h20", fonte: COTA },
  { naAula: "organizations.media_retention_days", naFonte: "organizations.media_retention_days", fonte: COTA },
  { naAula: "365 dias, com piso de 30", naFonte: "365** dias, piso **30**", fonte: COTA },
  { naAula: "Algo deu errado", naFonte: "Algo deu errado", fonte: COTA },
  { naAula: "projeto inteiro com 402", naFonte: "402 do projeto inteiro", fonte: COTA },
  { naAula: "522 ou 503 PGRST002", naFonte: "503 `PGRST002`", fonte: MEMORIA },
  { naAula: "Nano, de 0,5 GB", naFonte: "Nano, 0,5 GB", fonte: MEMORIA },
  { naAula: "cerca de 6 horas fora", naFonte: "~6 h", fonte: MEMORIA },
  { naAula: "Restart project", naFonte: "Restart project", fonte: MEMORIA },
  { naAula: "O Micro tem 1 GB, o dobro", naFonte: "**Micro = 1 GB**: o **dobro**", fonte: MEMORIA },
  { naAula: "menos de 2 minutos", naFonte: "menos de 2 minutos", fonte: MEMORIA },
  { naAula: "VPS no Brasil pede São Paulo", naFonte: "South America (São Paulo)", fonte: SETUP },
  { naAula: "não muda depois", naFonte: "A região não muda depois", fonte: SETUP },
];

function modulo() {
  return Modulo.parse(JSON.parse(fs.readFileSync(path.join(RAIZ, MODULO), "utf8")));
}

function licao() {
  const achada = modulo().licoes.find((l) => l.id === AULA);
  if (!achada) throw new Error(`a aula ${AULA} saiu de ${MODULO}`);
  return achada;
}

/** Todo o texto que o aluno lê nesta lição, normalizado. */
function prosa() {
  const l = licao();
  return normalizar(
    [l.titulo, l.objetivo, ...l.passos.flatMap((p) => [p.titulo, p.texto, p.dica ?? ""])].join(" \n "),
  );
}

/** Quais pares não fecham. Devolve o nome do trecho, para a mensagem dizer qual. */
function desencontrados(texto: string) {
  return TETOS.filter((t) => !texto.includes(normalizar(t.naAula))).map((t) => t.naAula);
}

describe("aula do curso: tetos do Supabase rastreáveis à fonte", () => {
  it("a aula existe no módulo e continua ensinando uma tela do Admin", () => {
    expect(licao().papel).toBe("admin");
    expect(modulo().tela).toBe("/admin/sistema");
    expect(licao().passos.length).toBeGreaterThan(1);
    expect(licao().passos[0]?.rota).toBeTruthy();
  });

  it("todo teto citado na aula está escrito na fonte que ele aponta", () => {
    const texto = prosa();
    expect(desencontrados(texto), `teto citado na aula mas ausente nela:\n${desencontrados(texto).join("\n")}`).toEqual([]);

    const semFonte = TETOS.filter((t) => !ler(t.fonte).includes(normalizar(t.naFonte)));
    expect(semFonte.map((t) => `${t.fonte}: ${t.naFonte}`), "a fonte não diz mais isso").toEqual([]);
  });

  it("trocar um teto na aula reprova (a cerca olha o alvo, não só o contrato)", () => {
    // Caso sintético: sem ele, uma aula reescrita sem nenhum dos trechos acima
    // passaria pela asserção vazia — "todo" sobre conjunto vazio é sempre true.
    expect(TETOS.length).toBeGreaterThan(10);
    const sabotada = prosa().replace("5 GB por mês de egress", "50 GB por mês de egress");
    expect(desencontrados(sabotada)).toContain("5 GB por mês de egress");

    const semUnidade = prosa().replace("500 MB de banco", "500 de banco");
    expect(desencontrados(semUnidade)).toContain("500 MB de banco");
  });

  it("os runbooks que a aula manda abrir existem no caminho citado", () => {
    const texto = licao().passos.map((p) => p.texto).join(" ");
    const caminhos = [...texto.matchAll(/docs\/runbooks\/[a-z0-9-]+\.md/g)].map((m) => m[0]);
    expect(new Set(caminhos).size).toBeGreaterThan(0);
    for (const caminho of caminhos) {
      expect(fs.existsSync(path.join(RAIZ, caminho)), `a aula aponta para ${caminho}, que não existe`).toBe(true);
    }
  });
});
