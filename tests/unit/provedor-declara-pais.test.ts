/**
 * ONDE O TEXTO DO CLIENTE É PROCESSADO — e por que a resposta pode ser "não sei".
 *
 * O contrato do operador (`docs/saas/contrato-e-lgpd.md`) já dizia que a conversa
 * vai "para provedores fora do Brasil"; o produto não dizia PARA ONDE. Este teste
 * guarda a regra que torna o campo confiável: país só existe com fonte e data.
 *
 * Sem essa guarda, `pais` vira texto de vitrine — alguém preenche "Estados Unidos"
 * porque o provedor é americano, a tela repete, e a cláusula do contrato passa a
 * afirmar algo que ninguém conferiu. Provedor que não declara região fica
 * `desconhecido` de propósito, e quem consome precisa dizer isso ao operador.
 */
import { describe, expect, it } from "vitest";

import { PROVEDORES, PROVEDORES_DE_DECISAO } from "@/lib/ai/pontos/provedores";
import { PROVEDORES_DE_SERVICO } from "@/lib/ai/pontos/provedores-de-servico";

/**
 * TUDO o que a tela de IA oferece, inclusive o provedor de voz: a tela de
 * Credenciais mostra a linha de residência em toda chave salva, então um
 * provedor fora desta lista seria justamente o que a tela não saberia
 * responder (#4519).
 */
const TODOS = [...PROVEDORES, ...PROVEDORES_DE_DECISAO, ...PROVEDORES_DE_SERVICO];

describe("o catálogo declara onde o texto é processado", () => {
  it("todo provedor responde à pergunta, mesmo quando a resposta é 'não se sabe'", () => {
    const semResposta = TODOS.filter((p) => p.pais.trim() === "").map((p) => p.id);
    expect(semResposta, "provedor sem `pais` deixa a cláusula de transferência sem resposta").toEqual([]);
  });

  it("país declarado exige fonte com URL e data; 'desconhecido' e 'local' não levam fonte", () => {
    const problemas: string[] = [];
    for (const p of TODOS) {
      const semDono = p.pais === "desconhecido" || p.pais === "local";
      if (semDono) {
        if (p.fonteDoPais !== null) problemas.push(`${p.id}: diz "${p.pais}" e ainda assim traz fonte`);
        continue;
      }
      if (p.fonteDoPais === null) {
        problemas.push(`${p.id}: declara "${p.pais}" sem fonte`);
        continue;
      }
      if (!/^https:\/\//.test(p.fonteDoPais.url)) problemas.push(`${p.id}: fonte sem URL https`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(p.fonteDoPais.consultadoEm)) {
        problemas.push(`${p.id}: fonte sem data de consulta`);
      }
    }
    expect(problemas).toEqual([]);
  });

  it("a DeepSeek é o caso de transferência para a China, com a fonte da própria empresa", () => {
    const deepseek = PROVEDORES.find((p) => p.id === "deepseek");
    expect(deepseek?.pais).toBe("China");
    // A declaração é da própria DeepSeek: processa e armazena na República Popular da China.
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
    // OpenRouter roteia por modelo, Requesty pode ficar na Europa por configuração e o
    // provedor personalizado é o endereço do operador: nenhum deles tem país próprio.
    for (const id of ["custom", "openrouter", "requesty"]) {
      expect(PROVEDORES.find((p) => p.id === id)?.pais, `${id} não deveria declarar país`).toBe("desconhecido");
    }
  });
});
