/**
 * A LISTA DA CAMPANHA DE VOLTA (issue #4360) — contrato do arquivo.
 *
 * O teste que importa aqui é o de IDA E VOLTA: o CSV que a rota entrega é lido
 * pelo importador de planilha de verdade (`parseImportFile` +
 * `lerPlanilhaDeProspeccao`, os mesmos da tela "Usar minha planilha"). Um
 * dialeto próprio passaria num teste que só olhasse as colunas escritas e
 * falharia na mão de quem tentasse reusar o arquivo.
 */
import { describe, expect, it } from "vitest";

import { parseImportFile } from "@/lib/planilha/ler-arquivo";
import { lerPlanilhaDeProspeccao } from "@/lib/prospecting/planilha";
import {
  COLUNAS_DA_LISTA,
  csvDaLista,
  naoAbordada,
  nomeDoArquivoDaLista,
  resumoDaLista,
  type CandidatoDaLista,
} from "@/lib/prospecting/exportar";

function empresa(extra: Partial<CandidatoDaLista["data"]> = {}): CandidatoDaLista["data"] {
  return {
    name: "Padaria do Zé",
    phone: "+5511988887777",
    website: "https://padaria.test/",
    category: "Padaria",
    address: "Rua das Flores, 10 - São Paulo",
    emails: ["contato@padaria.test"],
    socials: ["https://instagram.com/padaria"],
    ...extra,
  };
}

function linha(extra: Partial<CandidatoDaLista> = {}): CandidatoDaLista {
  return { status: "new", attempted_at: null, data: empresa(), ...extra };
}

describe("quem ainda pode ser abordado", () => {
  it("só entra quem nunca teve tentativa e continua na fila", () => {
    expect(naoAbordada(linha({ status: "new" }))).toBe(true);
    expect(naoAbordada(linha({ status: "queued" }))).toBe(true);
    // Já saiu mensagem (ou está saindo): não volta para outra campanha — o
    // contato e o negócio existem, e a triagem recusaria.
    for (const status of ["sending", "sent", "skipped", "failed"]) {
      expect(naoAbordada(linha({ status }))).toBe(false);
    }
  });

  it("tentativa registrada tira a empresa mesmo que o status tenha voltado para a fila", () => {
    expect(naoAbordada(linha({ status: "queued", attempted_at: "2026-11-01T12:00:00Z" }))).toBe(false);
  });

  it("número sem WhatsApp e linha sem telefone ficam de fora", () => {
    expect(naoAbordada(linha({ data: empresa({ whatsapp: { existe: false } }) }))).toBe(false);
    expect(naoAbordada(linha({ data: empresa({ phone: null }) }))).toBe(false);
  });

  it("o resumo conta sobre a lista inteira da campanha", () => {
    const resumo = resumoDaLista([
      linha(),
      linha({ status: "sent", attempted_at: "2026-11-01T12:00:00Z" }),
      linha({ status: "queued" }),
    ]);
    expect(resumo).toEqual({ total: 3, nao_abordadas: 2 });
  });
});

describe("o arquivo CSV", () => {
  it("sai com BOM, `;` e as colunas do modelo de importação", () => {
    const csv = csvDaLista([linha()]);
    expect(csv.startsWith("\uFEFF")).toBe(true);
    const [cabecalho] = csv.replace("\uFEFF", "").split("\r\n");
    expect(cabecalho).toBe("empresa;telefone;site;segmento;endereco;email;redes");
    expect(cabecalho?.split(";")).toEqual([...COLUNAS_DA_LISTA]);
    expect(csv).toContain("Padaria do Zé;+5511988887777;https://padaria.test/");
  });

  it("telefone E.164 não leva `'` de fórmula (senão a reimportação recusa o número)", () => {
    const csv = csvDaLista([linha()]);
    expect(csv).toContain(";+5511988887777;");
    expect(csv).not.toContain("'+55");
  });

  it("neutraliza célula que começa com fórmula e protege o separador", () => {
    const csv = csvDaLista([
      linha({ data: empresa({ name: "=HYPERLINK(\"x\")" }) }),
      linha({ data: empresa({ name: "Silva; Filhos" }) }),
    ]);
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain('"Silva; Filhos"');
  });

  it("lista vazia devolve só o cabeçalho", () => {
    expect(csvDaLista([]).replace("\uFEFF", "").trim()).toBe(COLUNAS_DA_LISTA.join(";"));
  });
});

describe("ida e volta pelo importador de planilha", () => {
  it("o arquivo exportado é lido de volta com as mesmas empresas e telefones", async () => {
    const candidatos = [
      linha(),
      linha({
        data: empresa({
          name: "Mercado \"Central\"",
          phone: "+5521977776666",
          website: null,
          address: null,
          emails: ["a@x.test", "b@x.test"],
          socials: [],
        }),
      }),
    ];
    const csv = csvDaLista(candidatos);
    const bytes = new TextEncoder().encode(csv).buffer as ArrayBuffer;
    const lido = await parseImportFile(bytes, "lista.csv");
    expect(lido.ok).toBe(true);
    if (!lido.ok) return;

    const planilha = lerPlanilhaDeProspeccao(lido.sheet);
    expect("erro" in planilha).toBe(false);
    if ("erro" in planilha) return;

    expect(planilha.erros).toEqual([]);
    expect(planilha.candidatos.map((c) => c.prospect.name)).toEqual([
      "Padaria do Zé",
      'Mercado "Central"',
    ]);
    expect(planilha.candidatos.map((c) => c.prospect.phone)).toEqual([
      "+5511988887777",
      "+5521977776666",
    ]);
    expect(planilha.candidatos[1]?.prospect.emails).toEqual(["a@x.test", "b@x.test"]);
  });
});

describe("nome do arquivo", () => {
  it("vira slug com a data, sem acento, espaço nem aspas", () => {
    expect(nomeDoArquivoDaLista("Clínicas de Estética \"Sul\"", new Date("2026-11-12T10:00:00Z"))).toBe(
      "lista-clinicas-de-estetica-sul-2026-11-12.csv",
    );
  });

  it("campanha sem letra nenhuma ainda gera nome válido", () => {
    expect(nomeDoArquivoDaLista("###", new Date("2026-11-12T10:00:00Z"))).toBe(
      "lista-prospeccao-2026-11-12.csv",
    );
  });
});
