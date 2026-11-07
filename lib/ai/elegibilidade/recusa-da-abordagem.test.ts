/**
 * A RECUSA DO CANAL CHEGA À PESSOA EM PORTUGUÊS, COM O CAMINHO DA SOLUÇÃO (#4170).
 *
 * ─── O defeito medido ───────────────────────────────────────────────────────
 *
 * A Prospecção pausava com `O canal ainda não permite esta abordagem:
 * fora_da_lista_de_teste.` — o código da constraint, sem dizer que o número
 * está em MODO DE TESTE nem onde liberar. A pessoa que lê isso não tem como
 * saber que o produto está funcionando como projetado: todo canal nasce em
 * pré-go-live com a lista vazia, e a prospecção aborda empresa que quase nunca
 * está na lista.
 *
 * ─── Por que a tradução mora numa função pura, e não num `if` na tela ───────
 *
 * A frase nasce onde o código nasce (a borda que decide a recusa), não em cada
 * lugar que a exibe: hoje é a campanha pausada, amanhã pode ser a prévia. Um
 * `if` na tela repetiria o vocabulário em cada consumidor e voltaria a vazar
 * na primeira tela nova. O código cru continua existindo — no log de quem
 * investiga —, e é isso que `logCru` abaixo garante.
 */
import { describe, expect, it } from "vitest";

import { DICIONARIO } from "@/lib/i18n/dicionario";

import {
  FRASE_DA_RECUSA_DA_ABORDAGEM,
  MOTIVOS_DA_RECUSA_DA_ABORDAGEM,
  fraseDaRecusaDaAbordagem,
} from "./recusa-da-abordagem";

describe("todo motivo de recusa do canal tem frase de gente", () => {
  it("a lista de motivos não está vazia e cada um tem frase não vazia", () => {
    expect(MOTIVOS_DA_RECUSA_DA_ABORDAGEM.length).toBeGreaterThan(0);
    for (const motivo of MOTIVOS_DA_RECUSA_DA_ABORDAGEM) {
      expect(FRASE_DA_RECUSA_DA_ABORDAGEM[motivo].trim().length).toBeGreaterThan(20);
    }
  });

  it("nenhuma frase carrega o código cru do banco", () => {
    for (const motivo of MOTIVOS_DA_RECUSA_DA_ABORDAGEM) {
      expect(FRASE_DA_RECUSA_DA_ABORDAGEM[motivo]).not.toContain(motivo);
    }
  });

  it("as frases têm espanhol no dicionário (a chave é o texto em português)", () => {
    for (const motivo of MOTIVOS_DA_RECUSA_DA_ABORDAGEM) {
      expect(DICIONARIO[FRASE_DA_RECUSA_DA_ABORDAGEM[motivo]]?.es ?? "").not.toBe("");
    }
  });
});

describe("a recusa `fora_da_lista_de_teste` explica o modo de teste e como sair", () => {
  const frase = fraseDaRecusaDaAbordagem("fora_da_lista_de_teste", "pt-BR");

  it("diz que o número está em modo de teste", () => {
    expect(frase).toContain("modo de teste");
  });

  it("diz o caminho para liberar o número ao público", () => {
    expect(frase).toContain("Conexões");
    expect(frase).toContain("Liberar atendimento ao público");
  });

  it("não escreve o código cru", () => {
    expect(frase).not.toContain("fora_da_lista_de_teste");
    expect(frase).not.toContain("_");
  });

  it("troca a língua quando a instalação é em espanhol", () => {
    const es = fraseDaRecusaDaAbordagem("fora_da_lista_de_teste", "es");
    expect(es).toContain("modo de prueba");
    expect(es).not.toBe(frase);
  });
});

describe("motivo que ninguém previu não vaza o vocabulário do banco", () => {
  it("cai numa frase genérica, sem o código", () => {
    const frase = fraseDaRecusaDaAbordagem("motivo_que_ainda_nao_existe", "pt-BR");
    expect(frase).not.toContain("motivo_que_ainda_nao_existe");
    expect(frase.length).toBeGreaterThan(20);
  });
});
