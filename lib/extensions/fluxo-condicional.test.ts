import { describe, expect, it } from "vitest";
import { decidirDoFluxo, parseFluxoDoTurno, idiomaDaMensagem } from "./fluxo-do-turno";

const quando = (valores: string[]) => ({ campo: "categoria", valores });
function declaracao() {
  return {
    id: "coleta", idiomas: ["pt-BR"],
    gatilhos: [{ idioma: "pt-BR", texto: "pedido" }],
    perguntas: [
      { campo: "categoria", texto: { "pt-BR": "Qual categoria: alfa, beta ou gama?" }, opcoes: [
        { valor: "alfa", termos: ["alfa", "1"] },
        { valor: "beta", termos: ["beta", "2"] },
        { valor: "gama", termos: ["gama", "3"] },
      ] },
      { campo: "nome", texto: { "pt-BR": "Qual nome?" }, quando: quando(["beta", "gama"]) },
      { campo: "data-beta", texto: { "pt-BR": "Qual data do procedimento?" }, quando: quando(["beta"]), extrair: { tipo: "data" } },
      { campo: "responsavel", texto: { "pt-BR": "Qual responsável?" }, quando: quando(["beta"]), extrair: { tipo: "marcador", termos: ["Resp."], incluir_marcador: true } },
      { campo: "data-gama", texto: { "pt-BR": "Qual data do serviço?" }, quando: quando(["gama"]), extrair: { tipo: "data" } },
      { campo: "servico", texto: { "pt-BR": "Qual serviço?" }, quando: quando(["gama"]) },
    ],
    encerrar_quando: quando(["alfa"]),
    contexto: { campo: "categoria", marcadores: ["registro concluído"], padrao: "alfa" },
    desfecho: { tipo: "passar_para_humano", aviso: { "pt-BR": "A equipe vai conferir agora." } },
    teto_de_turnos_sem_progresso: 2,
  };
}
const agora = "2026-10-26T12:00:00Z";
const entrada = (texto: string | null) => ({ texto, agora });

describe("coleta declarativa com opção finita, sem motor ou código do pacote", () => {
  it("opção de desfecho imediato não pede nem coleta dados pessoais", () => {
    const fluxo = parseFluxoDoTurno(declaracao());
    const decisao = decidirDoFluxo(fluxo, "acme/coleta", null, entrada("Preciso do pedido alfa"));
    expect(decisao).toMatchObject({ acao: "passar", campos: { categoria: "alfa" } });
  });

  it("o valor numérico da escolha leva só às perguntas daquele ramo", () => {
    const fluxo = parseFluxoDoTurno(declaracao());
    const abertura = decidirDoFluxo(fluxo, "acme/coleta", null, entrada("Preciso do pedido"));
    expect(abertura).toMatchObject({ acao: "perguntar", texto: "Qual categoria: alfa, beta ou gama?" });
    if (abertura.acao !== "perguntar") throw new Error("abertura esperada");
    const escolha = decidirDoFluxo(fluxo, "acme/coleta", abertura.estado, entrada("3"));
    expect(escolha).toMatchObject({ acao: "perguntar", texto: "Qual nome?" });
    if (escolha.acao !== "perguntar") throw new Error("coleta esperada");
    const nome = decidirDoFluxo(fluxo, "acme/coleta", escolha.estado, entrada("Nome sintético"));
    expect(nome).toMatchObject({ acao: "perguntar", texto: "Qual data do serviço?" });
  });

  it("aproveita data e marcador já informados junto à resposta pendente", () => {
    const fluxo = parseFluxoDoTurno(declaracao());
    const abertura = decidirDoFluxo(fluxo, "acme/coleta", null, entrada("Preciso do pedido beta"));
    if (abertura.acao !== "perguntar") throw new Error("coleta esperada");
    const fim = decidirDoFluxo(fluxo, "acme/coleta", abertura.estado,
      entrada("Pessoa Sintética, 12/10/2026, Resp. Equipe Sintética"));
    expect(fim).toMatchObject({ acao: "passar", campos: {
      categoria: "beta", nome: "Pessoa Sintética", "data-beta": "12/10/2026", responsavel: "Resp. Equipe Sintética",
    } });
  });

  it("contexto só preenche a opção declarada; valores livres não são herdados", () => {
    const fluxo = parseFluxoDoTurno(declaracao());
    const decisao = decidirDoFluxo(fluxo, "acme/coleta", null, {
      ...entrada("Preciso do pedido"), camposIniciais: { categoria: "alfa", nome: "Não herdar" },
    });
    expect(decisao).toMatchObject({ acao: "passar", campos: { categoria: "alfa" } });
    if (decisao.acao !== "passar") throw new Error("passagem esperada");
    expect(decisao.campos).not.toHaveProperty("nome");
  });

  it("referência futura, opção inexistente e JavaScript não entram no contrato", () => {
    const futuro = { ...declaracao(), perguntas: [
      { ...declaracao().perguntas[0]!, quando: quando(["beta"]) },
      ...declaracao().perguntas.slice(1),
    ] };
    expect(() => parseFluxoDoTurno(futuro)).toThrow();
    const desconhecida = declaracao();
    desconhecida.encerrar_quando.valores = ["inexistente"];
    expect(() => parseFluxoDoTurno(desconhecida)).toThrow();
    expect(() => parseFluxoDoTurno({ ...declaracao(), script: "return true" })).toThrow();
  });

  it("não transforma palavra de outra categoria em nome nem reaproveita campos do ramo anterior", () => {
    const fluxo = parseFluxoDoTurno(declaracao());
    const abertura = decidirDoFluxo(fluxo, "acme/coleta", null, entrada("Preciso do pedido beta"));
    if (abertura.acao !== "perguntar") throw new Error("coleta esperada");
    expect(decidirDoFluxo(fluxo, "acme/coleta", abertura.estado, entrada("gama"))).toEqual({
      acao: "devolver", porque: "fora_do_fluxo",
    });
  });

  it("hinglish usa escrita latina e o devanágari continua híndi", () => {
    expect(idiomaDaMensagem("mera report kab milegi")).toBe("hi-Latn");
    expect(idiomaDaMensagem("मेरा रिपोर्ट कहाँ है")).toBe("hi");
  });
  it("gatilho com marcador de intenção não captura menção ao assunto sem pedido de status", () => {
    const fluxo = parseFluxoDoTurno({ ...declaracao(),
      gatilhos: [{ idioma: "pt-BR", texto: "pedido", com_um_de: ["pronto", "status", "onde"] }],
    });
    expect(decidirDoFluxo(fluxo, "acme/coleta", null, entrada("Compartilhe o pedido"))).toMatchObject({ acao: "devolver" });
    expect(decidirDoFluxo(fluxo, "acme/coleta", null, entrada("Meu pedido está pronto?"))).toMatchObject({ acao: "perguntar" });
  });

});
