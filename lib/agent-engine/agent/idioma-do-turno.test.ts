/**
 * O IDIOMA DO TURNO — a régua da #4260, item 1.
 *
 * O que este arquivo prova, e por que ele olha o PROMPT e não a função:
 *
 *   - com `locale = es`, o texto que o motor injeta no turno NÃO contém as
 *     frases em português medidas no item 1 e contém a versão em espanhol;
 *   - com `locale = pt-BR`, cada bloco é o texto de HOJE, byte a byte (o
 *     controle: uma tradução não pode reescrever o atendimento brasileiro);
 *   - nenhum arquivo do motor compara idioma com literal — a decisão mora em
 *     `idioma-do-turno.ts` e o dicionário responde.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FUSO_PADRAO } from "@/lib/tempo/fusos";
import type { Queryable } from "../queue/queue";
import { CHECKPOINT_INSTRUCTION, instrucaoDeFechamento } from "./abertura/checkpoint";
import { DECLARACAO_INSTRUCTION, instrucaoDeDeclaracao } from "./declaracao";
import {
  INSTRUCAO_DA_CONSULTA_INTERNA,
  PERSONA_NEUTRA,
  instrucaoDaConsultaInterna,
  montarSystem,
  personaNeutra,
} from "./conversa-do-caso/contexto";
import { fatosDaOrganizacao } from "./fatos-da-organizacao";
import {
  FRASES_PT_DO_ITEM_1,
  blocosNoIdioma,
  diretivaDeIdioma,
  ferramentasNoIdioma,
  idiomaDoMotor,
} from "./idioma-do-turno";
import {
  AGENT_TOOL_DEFS,
  AUTORIA_SYSTEM_BLOCK,
  CASES_SYSTEM_BLOCK,
  TRANSPARENCIA_SYSTEM_BLOCK,
  blocoDoModoDePrevia,
  blocosDeAgendaResidentes,
} from "./inbound-turn";
import { SYSTEM_DO_OPERADOR, systemDoOperador } from "./operator-turn";

const TODAS_AS_FERRAMENTAS_DE_AGENDA = [
  "crm_find_free_slots",
  "crm_list_event_types",
  "crm_book_appointment",
  "crm_reschedule_appointment",
];

/**
 * Os blocos residentes na ORDEM da montagem — a mesma sequência do call site do
 * turno (playbook+memória, guardrails, casos, agenda, prévia, diretiva). Em
 * `pt-BR` são a chave: `blocosNoIdioma` devolve a lista como está.
 */
const BLOCOS_RESIDENTES_PT = [
  "Memória da organização.",
  TRANSPARENCIA_SYSTEM_BLOCK,
  AUTORIA_SYSTEM_BLOCK,
  CASES_SYSTEM_BLOCK,
  ...blocosDeAgendaResidentes(TODAS_AS_FERRAMENTAS_DE_AGENDA),
  blocoDoModoDePrevia("sandbox"),
  diretivaDeIdioma("pt-BR"),
];

/** O que o turno injeta de prosa fixa — na ordem, exatamente como o turno monta. */
function prosaDoSistemaDoTurno(idioma: "pt-BR" | "es"): string {
  const residentes = blocosNoIdioma(BLOCOS_RESIDENTES_PT, idioma);
  const descricoes = Object.values(ferramentasNoIdioma(AGENT_TOOL_DEFS, idioma)).map(
    (t) => t.description,
  );
  return [
    ...residentes,
    ...descricoes,
    montarSystem({ persona: "Persona do agente.", memoriaDaOrganizacao: null, idioma }),
    instrucaoDeFechamento(idioma),
    systemDoOperador(idioma),
    personaNeutra(idioma),
    instrucaoDaConsultaInterna(idioma),
    instrucaoDeDeclaracao(idioma),
  ].join("\n\n");
}

describe("o system do turno no idioma da organização", () => {
  it("es: não leva NENHUMA das frases pt-BR do item 1", () => {
    const sistema = prosaDoSistemaDoTurno("es");
    for (const frase of FRASES_PT_DO_ITEM_1) {
      expect(sistema, `frase pt-BR vazou para o turno em espanhol: ${frase}`).not.toContain(frase);
    }
  });

  it("es: leva a versão em espanhol de cada bloco, e a diretiva de idioma", () => {
    const sistema = prosaDoSistemaDoTurno("es");
    expect(sistema).toContain("Eres el asistente interno de este equipo de atención.");
    expect(sistema).toContain("Nunca inventes: sin fragmento que lo sostenga, no declares.");
    expect(sistema).toContain("Nunca inventes un avance sin evidencia en la conversación.");
    expect(sistema).toContain("Nunca inventes un `slug`");
    expect(sistema).toContain("Eres el operador del sistema.");
    expect(sistema).toContain("## Idioma de la conversación");
  });

  it("es: o bloco do MODO ASSISTIDO vai inteiro — as frases que definem o modo, não só a última", () => {
    const [bloco = ""] = blocosNoIdioma([blocoDoModoDePrevia("assisted")], "es");
    // As três frases que fazem do modo o que ele é: rascunho em nome do
    // atendente, primeira pessoa, e não falar como IA nem propor transferência.
    expect(bloco).toContain("MODO ASISTIDO");
    expect(bloco).toContain("BORRADOR");
    expect(bloco).toContain("en su nombre");
    expect(bloco).toContain("primera persona");
    expect(bloco).toContain("No hables como asistente ni como IA");
    expect(bloco).toContain("no propongas pasar la atención");
    expect(bloco).toContain("Propón el mensaje con send_message.");
    // E nada do texto em português sobra.
    expect(bloco).not.toContain("MODO ASSISTIDO");
    expect(bloco).not.toContain("RASCUNHO");
  });

  it("pt-BR: cada bloco é o texto de hoje, byte a byte (controle)", () => {
    expect(personaNeutra("pt-BR")).toBe(PERSONA_NEUTRA);
    expect(instrucaoDaConsultaInterna("pt-BR")).toBe(INSTRUCAO_DA_CONSULTA_INTERNA);
    expect(instrucaoDeDeclaracao("pt-BR")).toBe(DECLARACAO_INSTRUCTION);
    expect(instrucaoDeFechamento("pt-BR")).toBe(CHECKPOINT_INSTRUCTION);
    expect(systemDoOperador("pt-BR")).toBe(SYSTEM_DO_OPERADOR);
    expect(diretivaDeIdioma("pt-BR")).toContain("## Idioma da conversa");
  });

  it("pt-BR: os blocos residentes continuam os mesmos, e a diretiva é o único bloco novo", () => {
    const residentes = blocosNoIdioma(BLOCOS_RESIDENTES_PT, "pt-BR");
    expect(residentes).toEqual([
      "Memória da organização.",
      TRANSPARENCIA_SYSTEM_BLOCK,
      AUTORIA_SYSTEM_BLOCK,
      CASES_SYSTEM_BLOCK,
      ...blocosDeAgendaResidentes(TODAS_AS_FERRAMENTAS_DE_AGENDA),
      blocoDoModoDePrevia("sandbox"),
      diretivaDeIdioma("pt-BR"),
    ]);
  });

  it("o turno monta os blocos na ordem de antes e a diretiva entra por último", () => {
    const fonte = readFileSync(join(process.cwd(), "lib/agent-engine/agent/inbound-turn.ts"), "utf8");
    const inicio = fonte.indexOf("const blocosResidentes = [");
    expect(inicio).toBeGreaterThan(-1);
    // Só a REGIÃO da montagem: os mesmos blocos, na mesma sequência da main,
    // com a diretiva de idioma no fim (o único bloco novo).
    const trecho = fonte.slice(inicio, fonte.indexOf("const openingContext", inicio));
    const marcos = [
      "TRANSPARENCIA_SYSTEM_BLOCK, AUTORIA_SYSTEM_BLOCK",
      "push(CASES_SYSTEM_BLOCK)",
      "push(...blocosDeAgendaResidentes(",
      "push(blocoDoModoDePrevia(preview.kind))",
      "push(diretivaDeIdioma(idiomaDaOrg))",
    ];
    const posicoes = marcos.map((marco) => trecho.indexOf(marco));
    expect(posicoes.filter((p) => p < 0)).toEqual([]);
    expect(posicoes).toEqual([...posicoes].sort((a, b) => a - b));
    // E a tradução é uma passada DEPOIS da montagem, não um `idioma` por push.
    expect(fonte).toContain("blocosNoIdioma(blocosResidentes, idiomaDaOrg)");
  });

  it("pt-BR: o system da conversa do caso não muda quando o idioma não é passado", () => {
    const semIdioma = montarSystem({ persona: "Você é a Clara.", memoriaDaOrganizacao: null });
    const comPt = montarSystem({
      persona: "Você é a Clara.",
      memoriaDaOrganizacao: null,
      idioma: "pt-BR",
    });
    expect(comPt).toBe(semIdioma);
  });
});

describe("a descrição de ferramenta que carrega regra", () => {
  it("update_lead_state fala o idioma do turno; schema e nome não mudam", () => {
    const pt = AGENT_TOOL_DEFS.update_lead_state;
    const es = ferramentasNoIdioma(AGENT_TOOL_DEFS, "es").update_lead_state!;
    expect(pt.description).toContain("Nunca invente avanço sem evidência na conversa.");
    expect(es.description).not.toContain("Nunca invente avanço sem evidência na conversa.");
    expect(es.description).toContain("Nunca inventes un avance sin evidencia en la conversación.");
    expect(es.inputSchema).toBe(pt.inputSchema);
  });

  it("ferramenta sem tradução no dicionário volta igual (exceção declarada, não lista paralela)", () => {
    const es = ferramentasNoIdioma(AGENT_TOOL_DEFS, "es").save_lead_note!;
    expect(es.description).toBe(AGENT_TOOL_DEFS.save_lead_note.description);
  });
});

describe("o idioma chega ao turno sem consulta nova", () => {
  it("uma query traz fuso e idioma juntos", async () => {
    const consultas: string[] = [];
    const db: Queryable = {
      query: (async (sql: string) => {
        consultas.push(sql);
        return { rows: [{ timezone: "America/Sao_Paulo", locale: "es" }], rowCount: 1 };
      }) as unknown as Queryable["query"],
    };
    await expect(fatosDaOrganizacao(db, "org-1")).resolves.toEqual({
      fuso: "America/Sao_Paulo",
      idioma: "es",
    });
    expect(consultas).toHaveLength(1);
  });

  it("locale nulo, desconhecido ou leitura que falha degradam para pt-BR", async () => {
    const nulo: Queryable = {
      query: (async () => ({ rows: [{ timezone: "America/Sao_Paulo", locale: null }], rowCount: 1 })) as unknown as Queryable["query"],
    };
    await expect(fatosDaOrganizacao(nulo, "org-1")).resolves.toEqual({
      fuso: "America/Sao_Paulo",
      idioma: "pt-BR",
    });

    const estourado: Queryable = {
      query: (async () => {
        throw new Error("banco fora");
      }) as unknown as Queryable["query"],
    };
    await expect(fatosDaOrganizacao(estourado, "org-1")).resolves.toEqual({
      fuso: FUSO_PADRAO,
      idioma: "pt-BR",
    });
  });

  it("normalizarIdioma fecha o campo da organização no padrão do produto", () => {
    expect(idiomaDoMotor("es")).toBe("es");
    expect(idiomaDoMotor("pt-BR")).toBe("pt-BR");
    expect(idiomaDoMotor(null)).toBe("pt-BR");
    expect(idiomaDoMotor("klingon")).toBe("pt-BR");
  });
});

describe("a decisão de idioma não se espalha pelo motor", () => {
  const raiz = join(process.cwd(), "lib/agent-engine");

  function arquivos(dir: string): string[] {
    return readdirSync(dir).flatMap((nome) => {
      const caminho = join(dir, nome);
      if (statSync(caminho).isDirectory()) return arquivos(caminho);
      return caminho.endsWith(".ts") ? [caminho] : [];
    });
  }

  it("nenhum arquivo compara o locale com literal de idioma (fora do módulo do idioma)", () => {
    const suspeitos = arquivos(raiz)
      .filter((caminho) => !caminho.endsWith("idioma-do-turno.ts"))
      .filter((caminho) => !caminho.endsWith("idioma-do-turno.test.ts"))
      .filter((caminho) => /locale\s*===\s*["']es["']|idioma\s*===\s*["']es["']/.test(readFileSync(caminho, "utf8")));
    expect(suspeitos).toEqual([]);
  });
});
