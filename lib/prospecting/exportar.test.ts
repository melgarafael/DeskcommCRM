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
  entraNaLista,
  ligarContatos,
  motivoForaDaLista,
  naLista,
  naoAbordada,
  nomeDoArquivoDaLista,
  resumoDaLista,
  situacaoDaEmpresa,
  type CandidatoDaLista,
  type ContatoDaLista,
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
    expect(resumo).toEqual({
      total: 3,
      nao_abordadas: 2,
      todas: 3,
      fora_da_lista: { dados_apagados: 0, pediu_para_parar: 0, ficha_pessoal: 0 },
    });
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

/**
 * A LISTA INTEIRA (`quem=todas`) e o que nunca sai (decisão D13).
 *
 * O caso que importa é a campanha CONCLUÍDA: todo mundo já foi abordado, então a
 * lista das não abordadas é vazia — era nela que o botão sumia. A lista inteira
 * tem de trazer as M empresas que podem sair, e nenhuma das que nunca saem:
 * quem pediu para parar (bloqueio ou recusa de marketing, pelo vínculo OU pelo
 * telefone em outra grafia), contato pessoal e quem teve os dados apagados.
 */
describe("a lista inteira da campanha concluída", () => {
  const abordada = (nome: string, telefone: string, extra: Partial<CandidatoDaLista> = {}) =>
    linha({
      status: "sent",
      attempted_at: "2026-11-01T12:00:00Z",
      phone: telefone,
      data: empresa({ name: nome, phone: telefone }),
      ...extra,
    });

  const CAMPANHA_CONCLUIDA: CandidatoDaLista[] = [
    abordada("Sem Resposta", "+5511911110001"),
    abordada("Respondeu Sim", "+5511911110002", { respondeu: true }),
    abordada("Falhou Antes", "+5511911110003", { status: "failed", attempted_at: null }),
    // Pediu PARAR: o contato da própria abordagem ficou bloqueado.
    abordada("Pediu Parar", "+5511911110004", { contact_id: "c-bloqueado" }),
    // Recusa de marketing gravada pela ficha (`granted: false`), sem vínculo:
    // achada pelo telefone.
    abordada("Recusou Marketing", "+5511911110005"),
    // Contato pessoal achado pelo telefone EXTRA, na grafia sem o nono dígito.
    abordada("Contato Pessoal", "+5511987650006"),
    // Contato anonimizado pela LGPD.
    abordada("Anonimizado", "+5511911110007", { contact_id: "c-anonimo" }),
    // Linha suprimida pela cascata: dados já trocados, só a marca sobra.
    linha({ status: "skipped", suprimida: true, phone: null, data: empresa({ name: "Cliente Anonimizado #3", phone: null }) }),
  ];
  const CONTATOS: ContatoDaLista[] = [
    { id: "c-bloqueado", telefone: "+5511911110004", is_blocked: true },
    { id: "c-recusa", telefone: "+5511911110005", consent: { marketing: { granted: false } } },
    { id: "c-pessoal", telefone: "+551187650006", is_personal: true },
    { id: "c-anonimo", telefone: null, is_anonymized: true },
    // Contato comum de quem respondeu: não tira ninguém do arquivo.
    { id: "c-ok", telefone: "+5511911110002" },
  ];
  const ligados = ligarContatos(CAMPANHA_CONCLUIDA, CONTATOS);

  it("devolve as M empresas que podem sair, e nenhuma das que nunca saem", () => {
    const saem = ligados.filter(naLista);
    expect(saem.map((c) => c.data.name)).toEqual(["Sem Resposta", "Respondeu Sim", "Falhou Antes"]);

    const csv = csvDaLista(saem, { comSituacao: true });
    for (const vetado of ["Pediu Parar", "Recusou Marketing", "Contato Pessoal", "Anonimizado", "Cliente Anonimizado"])
      expect(csv).not.toContain(vetado);
    for (const telefone of ["+5511911110004", "+5511911110005", "+5511987650006", "+5511911110007"])
      expect(csv).not.toContain(telefone);
  });

  it("a lista das não abordadas é vazia, e o resumo conta quem ficou de fora por motivo", () => {
    expect(ligados.filter((c) => entraNaLista(c, "nao_abordadas"))).toEqual([]);
    expect(resumoDaLista(ligados)).toEqual({
      total: 8,
      nao_abordadas: 0,
      todas: 3,
      fora_da_lista: { dados_apagados: 2, pediu_para_parar: 2, ficha_pessoal: 1 },
    });
  });

  it("quem pediu para parar também não sai na lista das não abordadas", () => {
    const [nova] = ligarContatos(
      [linha({ phone: "+5511911110009", data: empresa({ phone: "+5511911110009" }) })],
      [{ id: "x", telefone: "+5511911110009", consent: { marketing: { declined_at: "2026-11-01T00:00:00Z" } } }],
    );
    expect(naoAbordada(nova!)).toBe(true);
    expect(motivoForaDaLista(nova!)).toBe("pediu_para_parar");
    expect(entraNaLista(nova!, "nao_abordadas")).toBe(false);
  });

  it("a coluna `situacao` vem no fim e diz o que aconteceu com cada empresa", () => {
    const csv = csvDaLista(ligados.filter(naLista), { comSituacao: true }).replace("\uFEFF", "");
    const [cabecalho, ...linhas] = csv.trim().split("\r\n");
    expect(cabecalho).toBe("empresa;telefone;site;segmento;endereco;email;redes;situacao");
    // "Falhou Antes" falhou SEM tentativa: não foi abordada, mas também não está
    // na fila — não é "não abordada" (o menu não a conta).
    expect(linhas.map((l) => l.split(";").at(-1))).toEqual(["abordada", "respondeu", "fora da fila"]);
  });

  it("`abordada` só com envio confirmado: tentativa sem confirmação não é abordagem", () => {
    const tentou = "2026-11-01T12:00:00Z";
    expect(situacaoDaEmpresa(linha({ status: "sent", attempted_at: tentou }))).toBe("abordada");
    // O worker grava `attempted_at` ANTES da guarda, da IA e da autorização: a
    // linha que falhou num desses passos não recebeu mensagem nenhuma.
    expect(situacaoDaEmpresa(linha({ status: "failed", attempted_at: tentou }))).toBe("envio não confirmado");
    expect(situacaoDaEmpresa(linha({ status: "sending", attempted_at: tentou }))).toBe("envio não confirmado");
    expect(situacaoDaEmpresa(linha({ status: "queued", attempted_at: tentou }))).toBe("envio não confirmado");
    expect(situacaoDaEmpresa(linha({ status: "sent", respondeu: true }))).toBe("respondeu");
  });

  it("`não abordada` é a MESMA régua do arquivo das não abordadas e do número do menu", () => {
    const campanha: CandidatoDaLista[] = [
      linha({ status: "new" }),
      linha({ status: "queued" }),
      // A triagem pulou: já é contato do CRM, ou o número não tem WhatsApp.
      linha({ status: "skipped" }),
      linha({ status: "failed" }),
      linha({ status: "new", data: empresa({ whatsapp: { existe: false } }) }),
      linha({ status: "new", data: empresa({ phone: null }) }),
      linha({ status: "sent", attempted_at: "2026-11-01T12:00:00Z" }),
    ];
    const situacoes = campanha.map(situacaoDaEmpresa);
    expect(situacoes).toEqual([
      "não abordada",
      "não abordada",
      "fora da fila",
      "fora da fila",
      "fora da fila",
      "fora da fila",
      "abordada",
    ]);
    expect(situacoes.filter((s) => s === "não abordada")).toHaveLength(resumoDaLista(campanha).nao_abordadas);
  });

  it("a situação pode sair no idioma da organização", () => {
    const csv = csvDaLista([linha({ respondeu: true })], {
      comSituacao: true,
      rotuloDaSituacao: (s) => (s === "respondeu" ? "respondió" : s),
    });
    expect(csv).toContain(";respondió\r\n");
  });

  it("o arquivo completo volta pelo importador, com `situacao` como coluna ignorada", async () => {
    const csv = csvDaLista(ligados.filter(naLista), { comSituacao: true });
    const bytes = new TextEncoder().encode(csv).buffer as ArrayBuffer;
    const lido = await parseImportFile(bytes, "lista-completa.csv");
    expect(lido.ok).toBe(true);
    if (!lido.ok) return;
    const planilha = lerPlanilhaDeProspeccao(lido.sheet);
    if ("erro" in planilha) throw new Error(planilha.erro);
    expect(planilha.erros).toEqual([]);
    expect(planilha.colunasIgnoradas).toEqual(["situacao"]);
    expect(planilha.candidatos.map((c) => c.prospect.phone)).toEqual([
      "+5511911110001",
      "+5511911110002",
      "+5511911110003",
    ]);
  });

  it("sem contato nenhum, a empresa pode sair", () => {
    expect(motivoForaDaLista(linha())).toBeNull();
    expect(ligarContatos([linha()], [])[0]?.contatos).toEqual([]);
  });
});

describe("nome do arquivo", () => {
  it("a lista inteira ganha outro nome, para não sobrescrever a das não abordadas", () => {
    expect(nomeDoArquivoDaLista("Clínicas", new Date("2026-11-12T10:00:00Z"), "todas")).toBe(
      "lista-completa-clinicas-2026-11-12.csv",
    );
  });

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
