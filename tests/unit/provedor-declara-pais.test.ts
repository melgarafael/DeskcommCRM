/**
 * ONDE O TEXTO DO CLIENTE É PROCESSADO — e por que a resposta pode ser "não sei".
 *
 * O contrato do operador (`docs/saas/contrato-e-lgpd.md`) já dizia que a conversa
 * vai "para provedores fora do Brasil"; o produto não dizia PARA ONDE. Este teste
 * guarda a regra do campo depois do #4588: `pais` é CÓDIGO de um vocabulário
 * FECHADO (`PaisDoProvedor`), e o catálogo separa DUAS perguntas que o #4520
 * tinha juntado num campo só —
 *
 *   - `sede`: onde fica a empresa que recebe o texto, registrado por nós;
 *   - `paisDeclarado`: onde o PROVEDOR diz que processa, e só existe junto com
 *     `fonteDoPais` (URL do documento e data da consulta).
 *
 * A diferença é o defeito que o #4588 consertou: seis provedores tinham em `pais`
 * a sede (Estados Unidos) e a cláusula 9 anunciava aquilo como "declaração de cada
 * provedor, consultada em data" — afirmação que nenhum deles fez. `pais` continua
 * sendo o código que as superfícies imprimem, e as duas invariantes abaixo
 * impedem que ele volte a misturar os casos: nenhum provedor muda de país, e
 * declaração sem fonte (ou fonte sem declaração) reprova.
 *
 * O que continua proibido — e é o que este arquivo também prova — é país FORA do
 * vocabulário, `desconhecido` com fonte, e fonte sem URL https ou sem data de
 * calendário.
 */
import { describe, expect, it } from "vitest";

import { PROVEDORES, PROVEDORES_DE_DECISAO } from "@/lib/ai/pontos/provedores";
import type { PaisDoProvedor, ProvedorSuportado } from "@/lib/ai/pontos/provedores";
import { PROVEDORES_DE_SERVICO } from "@/lib/ai/pontos/provedores-de-servico";
import { CONSULTA_DOS_PAISES_EM } from "@/lib/legal/operador";

/** O vocabulário fechado que a cláusula 9 sabe imprimir. */
const VOCABULARIO: readonly PaisDoProvedor[] = ["US", "CN", "UE", "operador", "desconhecido"];

/** O que este teste lê de cada entrada: os dois países e a fonte da declaração. */
type DeclaracaoDePais = Pick<
  ProvedorSuportado,
  "id" | "pais" | "sede" | "paisDeclarado" | "fonteDoPais" | "motivoDaRegiaoNaoDeclarada"
> & {
  /**
   * Opcionais porque o catálogo de SERVIÇO não os tem: a ElevenLabs recebe o
   * áudio por API própria e não aceita base URL alternativa. A régua abaixo
   * lê a presença do campo, e não o valor do tipo, justamente para cobrar que
   * quem aceita endpoint próprio responda — e que quem não aceita não invente.
   */
  aceitaEndpointProprio?: boolean;
  ondeExecutaComEndpointProprio?: string | null;
};

/**
 * TUDO o que a tela de IA oferece, inclusive o provedor de voz: a tela de
 * Credenciais mostra a linha de residência em toda chave salva, então um
 * provedor fora desta lista seria justamente o que a tela não saberia
 * responder (#4519).
 *
 * A lista é lida pela FORMA DO CONTRATO (`DeclaracaoDePais`), não pelos
 * literais congelados de cada entrada: as listas são `as const`, e comparar
 * contra a união literal faria o TS estreitar `p` até `never` e apagar
 * `id`/`pais`.
 */
const TODOS: readonly DeclaracaoDePais[] = [
  ...PROVEDORES,
  ...PROVEDORES_DE_DECISAO,
  ...PROVEDORES_DE_SERVICO,
];

describe("o catálogo declara onde o texto é processado", () => {
  it("todo provedor responde à pergunta, mesmo quando a resposta é 'não se sabe'", () => {
    const semResposta = TODOS.filter((p) => p.pais.trim() === "").map((p) => p.id);
    expect(semResposta, "provedor sem `pais` deixa a cláusula de transferência sem resposta").toEqual([]);
  });

  it("`pais` é sempre CÓDIGO do vocabulário fechado — texto livre não entra", () => {
    // É a colisão que o #4520 resolveu: "China" (por extenso) e "CN" (código) no
    // mesmo campo. A cláusula 9 indexa `NOME_DO_PAIS` pelo código; um valor fora
    // dele viraria `undefined` na cláusula e sumiria da tela.
    const fora = TODOS.filter((p) => !VOCABULARIO.includes(p.pais)).map((p) => `${p.id}: ${p.pais}`);
    expect(fora, "use o código de `PaisDoProvedor`, não um país por extenso").toEqual([]);
  });

  it("'desconhecido' e 'operador' não levam fonte; fonte, quando existe, tem URL https e data", () => {
    const problemas: string[] = [];
    for (const p of TODOS) {
      const semPais = p.pais === "desconhecido" || p.pais === "operador";
      if (semPais) {
        if (p.fonteDoPais !== null) problemas.push(`${p.id}: diz "${p.pais}" e ainda assim traz fonte`);
        continue;
      }
      if (p.fonteDoPais === null) continue; // declaração do catálogo — ver o teste abaixo
      if (!/^https:\/\//.test(p.fonteDoPais.url)) problemas.push(`${p.id}: fonte sem URL https`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(p.fonteDoPais.consultadoEm)) {
        problemas.push(`${p.id}: fonte sem data de consulta`);
      }
    }
    expect(problemas).toEqual([]);
  });

  it("`sede` é onde fica a empresa; `paisDeclarado` só existe COM fonte — os dois casos não se misturam", () => {
    // O #4588: `pais` sozinho não distingue "o provedor declarou a região de
    // processamento" de "esta é a sede de quem recebe o texto". Sem esta
    // invariante, a cláusula 9 volta a anunciar uma declaração que ninguém fez.
    const problemas: string[] = [];
    for (const p of TODOS) {
      const temPaisDeVerdade = p.pais !== "desconhecido" && p.pais !== "operador";
      if (temPaisDeVerdade) {
        // Um dos dois tem de carregar o código que a tela e o contrato imprimem.
        if ((p.paisDeclarado ?? p.sede) !== p.pais) {
          problemas.push(`${p.id}: pais "${p.pais}" não é a declaração nem a sede`);
        }
      } else if (p.sede !== null || p.paisDeclarado !== null) {
        problemas.push(`${p.id}: diz "${p.pais}" e ainda assim tem sede/declaração`);
      }
      // Declaração sem documento citável seria afirmação de ninguém.
      if ((p.paisDeclarado !== null) !== (p.fonteDoPais !== null)) {
        problemas.push(`${p.id}: declaração e fonte discordam (${p.paisDeclarado}/${p.fonteDoPais ? "com fonte" : "sem fonte"})`);
      }
    }
    expect(problemas).toEqual([]);

    // E existe pelo menos um caso de cada tipo — senão a régua mede o vazio.
    expect(TODOS.filter((p) => p.paisDeclarado !== null).map((p) => p.id)).toEqual(["deepseek"]);
    expect(TODOS.filter((p) => p.paisDeclarado === null && p.sede !== null).length).toBeGreaterThan(0);
  });

  it("a conferência do catálogo é uma data real — ela data a SEDE, não uma declaração", () => {
    expect(CONSULTA_DOS_PAISES_EM).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const hoje = new Date().toISOString().slice(0, 10);
    expect(
      CONSULTA_DOS_PAISES_EM <= hoje,
      `data de conferência no futuro é fonte inventada (${CONSULTA_DOS_PAISES_EM} > ${hoje})`,
    ).toBe(true);

    const comPais = TODOS.filter((p) => p.pais !== "desconhecido" && p.pais !== "operador");
    expect(comPais.length, "o catálogo não tem nenhum país registrado — a régua mediria o vazio").toBeGreaterThan(0);
  });

  it("a DeepSeek é o caso de transferência para a China, com a fonte da própria empresa", () => {
    const deepseek = PROVEDORES.find((p) => p.id === "deepseek");
    expect(deepseek?.pais).toBe("CN");
    // A declaração é da própria DeepSeek: processa e armazena na República Popular da China.
    // Desde o #4588 ela é a ÚNICA entrada com `paisDeclarado` — é o que autoriza
    // a cláusula a dizer "declaração do provedor" nesta linha e só nesta.
    expect(deepseek?.paisDeclarado).toBe("CN");
    expect(deepseek?.fonteDoPais?.url).toContain("deepseek.com");
  });

  it("a data da consulta existe, é uma data de calendário e não está no futuro", () => {
    const hoje = new Date().toISOString().slice(0, 10);
    const problemas: string[] = [];
    for (const p of TODOS) {
      if (!p.fonteDoPais) continue;
      const { consultadoEm } = p.fonteDoPais;
      const data = new Date(`${consultadoEm}T00:00:00Z`);
      if (Number.isNaN(data.getTime()) || data.toISOString().slice(0, 10) !== consultadoEm) {
        problemas.push(`${p.id}: "${consultadoEm}" não é data de calendário`);
      }
      // Data no futuro quer dizer que ninguém consultou de fato — é o formato
      // mais elegante de fonte inventada.
      if (consultadoEm > hoje) problemas.push(`${p.id}: consulta datada no futuro (${consultadoEm})`);
    }
    expect(problemas).toEqual([]);
  });

  it("gateway e endpoint próprio não fingem saber onde ficam", () => {
    // OpenRouter é sede nos EUA mas roteia por modelo; Requesty pode ficar na
    // Europa por configuração e não tem fonte citável; o provedor personalizado é
    // o endereço do operador — que não é país nenhum.
    for (const id of ["custom", "requesty"]) {
      const pais = PROVEDORES.find((p) => p.id === id)?.pais;
      expect(["desconhecido", "operador"], `${id} não deveria declarar país`).toContain(pais);
    }
    // E o valor do `custom` diz exatamente "o servidor do operador", não "não sei":
    // a cláusula 9 tem frase própria para ele.
    expect(PROVEDORES.find((p) => p.id === "custom")?.pais).toBe("operador");
  });
});

/**
 * O QUE FALTA QUANDO NÃO HÁ DECLARAÇÃO — e o que o endpoint próprio faz com o
 * lugar (#4518).
 *
 * `fonteDoPais: null` dizia que não há fonte e parava aí. Faltavam as duas
 * respostas que a tela e o documento precisam para não chutar: POR QUE o
 * provedor não declara a região, e o que acontece com o lugar quando o operador
 * aponta a base URL para outro host. Sem a primeira, "não sei" fica
 * indistinguível de "ninguém procurou"; sem a segunda, o catálogo herda o país
 * do provedor para uma chamada que sai pelo endereço do operador.
 *
 * A régua é a do catálogo INTEIRO (`TODOS`): provedor novo entra na lista e
 * reprova aqui se não responder — não há amostra, e não há entrada isenta.
 */
describe("#4518 — motivo da ausência e efeito do endpoint próprio", () => {
  it("todo provedor tem o campo, e exatamente uma das duas respostas", () => {
    const problemas: string[] = [];
    for (const p of TODOS) {
      // Presença EXPLÍCITA: `undefined` (campo esquecido) não pode passar como
      // se fosse `null`, que é a resposta "há declaração, logo não há motivo".
      if (!Object.prototype.hasOwnProperty.call(p, "motivoDaRegiaoNaoDeclarada")) {
        problemas.push(`${p.id}: sem o campo motivoDaRegiaoNaoDeclarada`);
        continue;
      }
      const temDeclaracao = p.paisDeclarado !== null;
      const motivo = p.motivoDaRegiaoNaoDeclarada;
      const temMotivo = typeof motivo === "string" && motivo.trim() !== "";
      if (temDeclaracao === temMotivo) {
        problemas.push(
          `${p.id}: ${temDeclaracao ? "declara a região e ainda dá motivo" : "não declara a região e não diz por quê"}`,
        );
        continue;
      }
      // Motivo curto ou de preenchimento é a resposta de quem não conferiu.
      if (temMotivo && (motivo.trim().length < 24 || /^(desconhecid[oa]|n\/a|na|tbd|todo)$/i.test(motivo.trim()))) {
        problemas.push(`${p.id}: motivo vazio ou genérico ("${motivo}")`);
      }
    }
    expect(problemas).toEqual([]);
  });

  it("o motivo é POR PROVEDOR — razão repetida é resposta de quem não procurou", () => {
    const motivos = TODOS.map((p) => p.motivoDaRegiaoNaoDeclarada).filter(
      (m): m is string => typeof m === "string",
    );
    const repetidos = motivos.filter((m, i) => motivos.indexOf(m) !== i);
    expect(repetidos, "dois provedores com o mesmo motivo: um deles foi copiado").toEqual([]);
  });

  it("quem aceita endpoint próprio diz que a execução pode ser em qualquer lugar", () => {
    const problemas: string[] = [];
    for (const p of TODOS) {
      const aceita = "aceitaEndpointProprio" in p && p.aceitaEndpointProprio === true;
      const campo = "ondeExecutaComEndpointProprio" in p ? p.ondeExecutaComEndpointProprio : null;
      if (aceita) {
        if (typeof campo !== "string" || campo.trim().length < 24) {
          problemas.push(`${p.id}: aceita endpoint próprio e não diz o que acontece com o lugar`);
        }
      } else if (campo !== null && campo !== undefined) {
        problemas.push(`${p.id}: não aceita endpoint próprio e ainda descreve um efeito`);
      }
    }
    expect(problemas).toEqual([]);
    // E a régua tem os dois casos, senão mede o vazio.
    expect(TODOS.filter((p) => "aceitaEndpointProprio" in p && p.aceitaEndpointProprio).length).toBeGreaterThan(0);
    expect(TODOS.filter((p) => "aceitaEndpointProprio" in p && !p.aceitaEndpointProprio).length).toBeGreaterThan(0);
  });

  it("o provedor personalizado é o servidor do operador — o catálogo não sabe onde ele fica", () => {
    const custom = PROVEDORES.find((p) => p.id === "custom");
    expect(custom?.pais).toBe("operador");
    expect(custom?.ondeExecutaComEndpointProprio).toMatch(/servidor do operador|n\u00e3o sabe onde/);
  });

  it("a régua mede o catálogo inteiro, não uma amostra", () => {
    expect(TODOS.length).toBe(PROVEDORES.length + PROVEDORES_DE_DECISAO.length + PROVEDORES_DE_SERVICO.length);
    expect(TODOS.length, "catálogo pequeno demais: a régua mediria o vazio").toBeGreaterThanOrEqual(8);
    // Nenhum id repetido entre as três listas — o Map de cada catálogo ficaria
    // com a última entrada e uma delas sumiria da cláusula.
    expect(TODOS.map((p) => p.id).sort()).toEqual([...new Set(TODOS.map((p) => p.id))].sort());
  });
});
