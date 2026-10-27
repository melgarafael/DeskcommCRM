import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { checkCompatibility, parseCatalog, parseManifest } from "./manifest";
import { ExtensionError } from "./errors";
import { aceitePendente, motivoDeRecusaDoTurno } from "./consentimento";
import { decidirDoFluxo, type EstadoDoFluxo, type FluxoDoTurno } from "./fluxo-do-turno";

// Consumidor real de #3076, preservando os ramos de #3063 (@guptasp82-jpg).
const catalogo = parseCatalog(new Uint8Array(readFileSync(join(process.cwd(), "extensoes/catalogo.json"))));
const entrada = catalogo.entries.find((item) => item.name === "consulta-de-laudos");
if (!entrada) throw new Error("Consumidor real ausente do catálogo");
const bytes = new Uint8Array(readFileSync(join(process.cwd(), "extensoes/pacotes", entrada.publisher, `${entrada.name}-${entrada.version}.json`)));
const manifest = parseManifest(bytes);
const fluxo = manifest.contributions.turn_flow as FluxoDoTurno;
const identidade = `${manifest.publisher}/${manifest.name}`;
const agora = "2026-10-26T12:00:00Z";
const decidir = (texto: string | null, estado: EstadoDoFluxo | null = null) =>
  decidirDoFluxo(fluxo, identidade, estado, { texto, agora });
function jornada(textos: Array<string | null>) {
  let estado: EstadoDoFluxo | null = null;
  const bolhas: string[] = [];
  const decisoes = textos.map((texto) => {
    const decisao = decidir(texto, estado);
    if (decisao.acao === "perguntar") { estado = decisao.estado; bolhas.push(decisao.texto); }
    else {
      estado = null;
      if (decisao.acao === "passar") bolhas.push(decisao.aviso);
      if (decisao.acao === "concluir") bolhas.push(decisao.texto);
    }
    return decisao;
  });
  return { bolhas, ultimo: decisoes.at(-1)!, decisoes };
}

describe("o artefato publicado é o consumidor, sem trocar permissões da identidade antiga", () => {
  it("catálogo aponta para os bytes exatos e explicita a leitura opcional", () => {
    expect(entrada!.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(entrada!.byte_length).toBe(bytes.byteLength);
    expect(entrada!.permissions).toEqual(["turn.send", "turn.handoff", "turn.context"]);
    expect(checkCompatibility(manifest)).toEqual({ compatible: true, reason: null });
  });

  it("sem aceite não age; envio/passagem não concedem leitura por consequência", () => {
    expect(motivoDeRecusaDoTurno({ declaradas: manifest.permissions, aceitas: [], fluxo })).toBe("sem_aceite");
    const entrada = { declaradas: manifest.permissions, aceitas: ["turn.send", "turn.handoff"] as const, fluxo };
    expect(motivoDeRecusaDoTurno(entrada)).toBeNull();
    expect(aceitePendente(entrada)).toEqual([]);
    expect(() => parseManifest(new TextEncoder().encode(JSON.stringify({ ...manifest,
      permissions: ["turn.send", "turn.handoff"],
    })))).toThrow();
  });

  it("preserva a fonte linear arquivada, sem aceitar turno anunciado como API2", () => {
    const fonte = readFileSync(join(process.cwd(), "tests/fixtures/extensoes/laudo-linear-fonte3474.json"));
    // Nunca publicado: é a proveniência da contribuição, não um contrato API2 válido.
    const antigo = JSON.parse(fonte.toString("utf8")) as {
      permissions: string[]; name: string; contributions: { turn_flow: { perguntas: unknown[] } };
    };
    expect(() => parseManifest(fonte)).toThrow(ExtensionError);
    expect(antigo.permissions).toEqual(["turn.send", "turn.handoff"]);
    expect(antigo.name).not.toBe(manifest.name);
    expect(antigo.contributions.turn_flow!.perguntas).toHaveLength(4);
  });
});

describe("ramos do laudo: patologia entrega; biópsia e radiologia coletam só pendências", () => {
  it("patologia passa imediatamente, sem perguntar nome, data ou médico", () => {
    expect(decidir("Is my blood report ready?")).toMatchObject({ acao: "passar", campos: { categoria: "patologia" } });
  });

  it("biópsia coleta nome, data de cirurgia e médico, uma pergunta por vez", () => {
    const { bolhas, ultimo } = jornada(["Where is my biopsy report?", "Pessoa Sintética", "12/10/2026", "Dr. Sen"]);
    expect(bolhas.slice(0, 3)).toEqual(["Patient name, as on the registration?", "Date of surgery?", "Doctor's name or hospital name?"]);
    expect(ultimo).toMatchObject({ acao: "passar", campos: {
      categoria: "biopsia", nome: "Pessoa Sintética", "data-cirurgia": "12/10/2026", medico: "Dr. Sen",
    } });
    if (ultimo.acao !== "passar") throw new Error("passagem esperada");
    expect(ultimo.campos).not.toHaveProperty("data-exame");
    expect(ultimo.campos).not.toHaveProperty("exame");
  });

  it("data e médico informados na entrada não são perguntados outra vez", () => {
    const { bolhas, ultimo } = jornada(["Is my biopsy report ready? 12/10/2026 Dr. Sen", "Pessoa Sintética"]);
    expect(bolhas).toHaveLength(2); // nome + aviso da passagem; sem repetir data ou médico.
    expect(ultimo).toMatchObject({ acao: "passar", campos: {
      categoria: "biopsia", nome: "Pessoa Sintética", "data-cirurgia": "12/10/2026", medico: "Dr. Sen",
    } });
  });

  it("radiologia reaproveita os dados explícitos juntos e não pede médico", () => {
    const { bolhas, ultimo } = jornada(["Where is my radiology report?", "Pessoa Sintética, 12/10/2026, test: ECG"]);
    expect(bolhas).toHaveLength(2);
    expect(ultimo).toMatchObject({ acao: "passar", campos: {
      categoria: "radiologia", nome: "Pessoa Sintética", "data-exame": "12/10/2026", exame: "ECG",
    } });
    if (ultimo.acao !== "passar") throw new Error("passagem esperada");
    expect(ultimo.campos).not.toHaveProperty("medico");
    expect(ultimo.campos).not.toHaveProperty("data-cirurgia");
  });

  it("sem categoria confiável pergunta a opção e a escolha 1 passa sem coleta pessoal", () => {
    const { bolhas, ultimo } = jornada(["Where is my report?", "1"]);
    expect(bolhas).toHaveLength(2);
    expect(ultimo).toMatchObject({ acao: "passar", campos: { categoria: "patologia" } });
  });
});

describe("idiomas, intenção e saídas sem prender a conversa", () => {
  it.each([
    ["Meu laudo está pronto?", "De qual serviço é o laudo?"],
    ["¿Mi informe está listo?", "¿De qué servicio es el informe?"],
    ["मेरा रिपोर्ट कहाँ है", "यह रिपोर्ट किस सेवा की है?"],
    ["mera report kab milegi", "Yeh report kis service ki hai?"],
    ["report milegi", "Yeh report kis service ki hai?"],
    ["report mila", "Yeh report kis service ki hai?"],
  ])("%s usa o idioma declarado", (texto, inicio) => {
    const d = decidir(texto);
    expect(d.acao).toBe("perguntar");
    if (d.acao === "perguntar") expect(d.texto.startsWith(inicio)).toBe(true);
  });

  it("menção sem pedido de status, pergunta de preço e texto português com report seguem para IA", () => {
    for (const texto of ["Please share my report", "What is the price?", "qual o status do meu report?"]) {
      expect(decidir(texto)).toMatchObject({ acao: "devolver" });
    }
    const aberta = decidir("Where is my biopsy report?");
    if (aberta.acao !== "perguntar") throw new Error("coleta esperada");
    expect(decidir("What is the price?", aberta.estado)).toEqual({ acao: "devolver", porque: "fora_do_fluxo" });
  });

  it("saudação de confirmação não vira nome de paciente", () => {
    const aberta = decidir("Where is my biopsy report?");
    if (aberta.acao !== "perguntar") throw new Error("coleta esperada");
    expect(decidir("hello", aberta.estado)).toEqual({ acao: "devolver", porque: "fora_do_fluxo" });
  });

  it("três mensagens sem progresso levam à equipe e mídia posterior volta à IA", () => {
    const { ultimo } = jornada(["Where is my biopsy report?", null, null, null]);
    expect(ultimo).toMatchObject({ acao: "passar", porque: "teto", campos: { categoria: "biopsia" } });
    expect(decidir(null)).toEqual({ acao: "devolver", porque: "mensagem_vazia" });
  });
});
