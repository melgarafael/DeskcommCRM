import { describe, expect, it } from "vitest";
import { exigirBancoLocal, exigirHttpLocal } from "./seguranca";
import { exigirLanDaFonte } from "./preparar-fonte-loja";
import { chaveDaCena, idDaHistoria, lerHistorias, receitas, evolucaoDoCaso, exigirVersaoDaFoto } from "./receitas-jornadas";

describe("receitas reprodutíveis das jornadas", () => {
  it("cobre cada cena e sua foto exclusiva sem depender da saída ignorada", () => {
    const historias = lerHistorias();
    expect(receitas).toHaveLength(historias.length);
    const chaves: string[] = [], ids: string[] = [];
    for (const h of historias) {
      const r = receitas.find((x) => x.jornada === h.id)!;
      expect(r.cenas.map((c) => c.id)).toEqual(h.cenas.map((c) => c.id));
      expect(new Set(r.cenas.map((c) => c.superficie)).size).toBeGreaterThan(1);
      for (const c of h.cenas) {
        const chave = chaveDaCena(h.id, c.id);
        expect(c.captura).toBe(chave); chaves.push(chave);
      }
      for (let i = 1; i <= 6; i++) ids.push(idDaHistoria(h.id, i));
    }
    expect(chaves).toHaveLength(120);
    expect(new Set(chaves).size).toBe(chaves.length);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("a solicitação de informação precede a resposta e a passagem humana da troca", () => {
    const troca = receitas.find((r) => r.jornada === "e-commerce-troca-tamanho")!;
    expect(troca.cenas[2]!.acao_humana).toBe("need_lead_info");
    expect(evolucaoDoCaso(troca, 2)).toMatchObject({ status: "awaiting_human", fechado: false, eventos: [] });
    const continuacao = evolucaoDoCaso(troca, 3);
    expect(continuacao).toMatchObject({ status: "escalated", fechado: true });
    expect(continuacao.eventos.map((e) => [e.kind, e.human_action])).toEqual([
      ["human_replied", "need_lead_info"], ["lead_asked", undefined], ["lead_provided", undefined],
      ["human_replied", "escalate"], ["escalated", undefined],
    ]);
    const suporte = receitas.find((r) => r.jornada === "infoprodutos-acesso")!;
    expect(evolucaoDoCaso(suporte, 3)).toMatchObject({ status: "awaiting_lead", fechado: false });
    const semPergunta = structuredClone(troca);
    delete semPergunta.cenas[2]!.acao_humana;
    expect(() => evolucaoDoCaso(semPergunta, 3)).toThrow(/sem pergunta/);
  });
  it("a tarefa só termina onde a narrativa declara conferência concluída", () => {
    const historias = lerHistorias();
    const concluidas: string[] = [];
    for (const r of receitas) {
      let temTarefa = false;
      for (const [i, cena] of r.cenas.entries()) {
        temTarefa ||= cena.superficie === "tarefa";
        if (!temTarefa) continue;
        expect(cena.tarefa_status).toBeDefined();
        const narrativa = historias.find((h) => h.id === r.jornada)!.cenas[i]!.operacao;
        if (/tarefa é concluída|conclui a tarefa/.test(narrativa)) {
          expect(cena.tarefa_status).toBe("done"); concluidas.push(r.jornada);
        } else expect(["pending", "in_progress"]).toContain(cena.tarefa_status);
      }
    }
    expect(concluidas.sort()).toEqual(["advocacia-documentos", "consorcio-cadastro", "contabilidade-documentos-mensais"]);
  });
  it("não fabrica proveniência quando a versão do aplicativo é desconhecida", () => {
    for (const valor of [undefined, "", "  ", "v"]) expect(() => exigirVersaoDaFoto(valor)).toThrow("CURSO_VERSAO_FOTOS");
    expect(exigirVersaoDaFoto(" v1.89.0 ")).toBe("1.89.0");
  });
  it("recusa destinos remotos e redirecionamento por parâmetros, sem expor URL", () => {
    for (const url of ["https://localhost", "http://localhost.evil.test", "http://user:secret@localhost", "http://localhost/?host=evil", "http://localhost/caminho", "http://10.0.2.2:5432", "http://hg-vps"]) {
      expect(() => exigirHttpLocal(url)).toThrow(/local/);
    }
    expect(exigirHttpLocal("http://127.0.0.1:3460")).toBe("http://127.0.0.1:3460");
    expect(() => exigirBancoLocal("postgres://localhost/db?host=remote")).toThrow();
  });
  it("a fonte só aceita IP LAN explícito, sem relaxar a cerca de administração local", () => {
    for (const host of [undefined, "localhost", "127.0.0.1", "8.8.8.8", "10.0.2.2.evil.test", "169.254.169.254", "172.32.0.1"]) {
      expect(() => exigirLanDaFonte(host)).toThrow();
    }
    expect(exigirLanDaFonte("10.0.2.2")).toBe("10.0.2.2");
    expect(exigirLanDaFonte("172.16.0.2")).toBe("172.16.0.2");
    expect(() => exigirBancoLocal("postgres://10.0.2.2/db")).toThrow();
  });
  it("permite importar o capturador e os helpers sem contas ou conexão", async () => {
    // Estes imports eram um leitor de contas e uma conexão eager; CI não tem nenhum dos dois.
    const capturador = await import("./capturar");
    const semente = await import("./semear-demonstracao");
    expect(capturador.medir).toBeTypeOf("function");
    expect(semente.semearBase).toBeTypeOf("function");
  });
});
