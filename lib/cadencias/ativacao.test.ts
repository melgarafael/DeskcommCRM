import { describe, expect, it } from "vitest";
import { problemasParaAtivar } from "./ativacao";
import { configuracaoPadrao } from "./exemplos";
import { editarCadenciaSchema } from "./schemas";
import type { Passo } from "./tipos";
const email: Passo = { id: "email", tipo: "email", assunto: "Assunto", corpo: "Corpo", mesmaConversa: false };
describe("ativação só de consumidores reais", () => {
  it("aceita e-mail e recusa WhatsApp, clique e janela impossível", () => {
    const configuracao = configuracaoPadrao();
    expect(problemasParaAtivar({ configuracao, passos: [email] })).toEqual([]);
    expect(problemasParaAtivar({ configuracao, passos: [email, { id: "w", tipo: "whatsapp", mensagem: "x" }] })).not.toEqual([]);
    expect(problemasParaAtivar({ configuracao: { ...configuracao, janela: { ...configuracao.janela, inicio: "18:00", fim: "08:00" } }, passos: [email] })).not.toEqual([]);
  });
  it("não aceita controles de configuração sem consumidor nem descadastro desligado", () => {
    const base = configuracaoPadrao();
    for (const configuracao of [{ ...base, somenteEmailValidado: true }, { ...base, caixaPadraoId: "caixa-ficticia" }, { ...base, paradas: { ...base.paradas, respondeu: true } }, { ...base, paradas: { ...base.paradas, descadastro: false } }]) {
      expect(problemasParaAtivar({ configuracao, passos: [email] })).not.toEqual([]);
    }
  });
  it("ids repetidos e árvore profunda não passam pela API", () => {
    expect(editarCadenciaSchema.safeParse({ passos: [email, email] }).success).toBe(false);
    let passos: Passo[] = [email];
    for (let i = 0; i < 55; i++) passos = [{ id: `r${i}`, tipo: "ramo", condicao: { tipo: "abriu", vezes: 1, dentroDeDias: 1 }, sim: passos, nao: [] }];
    expect(editarCadenciaSchema.safeParse({ passos }).success).toBe(false);
  });
});
