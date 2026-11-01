/**
 * GERAR A PRÉVIA DE UM CANDIDATO — a morada única (B2).
 *
 * Duas portas chegam aqui: o CLIQUE do operador (rota `prever_abordagem`) e o
 * PREPARO AUTOMÁTICO (`preparo.ts`, a cada minuto, sem ninguém olhando). As duas
 * precisam entregar ao modelo EXATAMENTE os mesmos argumentos para o mesmo
 * candidato — se escrevessem cada uma o seu, a copy que o operador revisa na tela
 * e a que o sistema guardou sozinho seriam de autores diferentes. Prova em par:
 * `app/api/v1/prospecting/previa-em-par.test.ts`.
 *
 * Fica FORA daqui, de propósito, o que é de cada porta: a gravação
 * (`gravarPrevia`) e a auditoria. A rota audita `prospecting.preview_saved` por
 * clique; o preparo audita `prospecting.previews_generated` uma vez por rodada.
 *
 * A prévia gera DO ZERO: `montarDadosDeAbordagem(data, site)` sem o rascunho
 * guardado. Mandar o rascunho de volta ao modelo faria cada clique reescrever em
 * cima do anterior, e o operador nunca veria uma copy nova.
 */
import type pg from "pg";

import { gerarAbordagemDeFormulario } from "@/lib/agent-engine/agent/abordagem-de-formulario";
import { llmEdgeConfigFromEnv } from "@/lib/agent-engine/edge/llm/credentials";
import { env } from "@/lib/env";
import {
  estrategiaDoCandidato,
  instrucaoDeAbordagemFria,
  montarDadosDeAbordagem,
  pontuarCandidato,
  type EstrategiaDoLead,
  type OfertaDaCampanha,
  type Pontuacao,
} from "./estrategia-site";
import {
  blocoVozVendedor,
  personalizacaoDaOrganizacao,
  type PersonalizacaoProspeccao,
} from "./personalizar";
import { chaveDaAuditoria, type PreviaSalva } from "./previa";
import { campaignConfigSchema, type Prospect } from "./schema";
import { siteEfetivo } from "./site-efetivo";

/** O que a função precisa de um candidato (a rota e o preparo leem o mesmo recorte). */
export interface LinhaParaPrevia {
  id: string;
  data: Prospect;
  status: string;
  contact_id: string | null;
  /** `prospecting_campaigns.config` CRU: quem decide se está completa é o schema, aqui. */
  config: unknown;
  search: { niche?: string } | null;
}

/** Por que não saiu prévia — a rota traduz em 409/422, o preparo só registra. */
export type MotivoSemPrevia = "auditoria_pendente" | "sem_agente" | "ia_falhou";

export type ResultadoDaPrevia =
  | {
      ok: true;
      texto: string;
      previa: PreviaSalva;
      estrategia: EstrategiaDoLead;
      score: Pontuacao;
    }
  | { ok: false; motivo: MotivoSemPrevia; detalhe?: string };

export async function gerarPreviaDoCandidato(
  pool: pg.Pool,
  org: string,
  linha: LinhaParaPrevia,
  opcoes: {
    /** Já lida pelo chamador (o preparo lê UMA vez por rodada, não por candidato). */
    personalizacao?: PersonalizacaoProspeccao;
  } = {},
): Promise<ResultadoDaPrevia> {
  // A prévia usa o MESMO veredito que a tela mostra. Quem não tem site próprio
  // já tem `sem-site` derivado (sem rede); o "pendente" fica só para quem tem
  // site na web e ainda espera a auditoria.
  const site = siteEfetivo(linha.data, new Date().toISOString());
  if (!site) return { ok: false, motivo: "auditoria_pendente" };
  // Config parcial salva pelo meio (sem `agent_id`) não é campanha configurada.
  const cfg = linha.config ? campaignConfigSchema.safeParse(linha.config) : null;
  if (!cfg?.success || !cfg.data.agent_id) return { ok: false, motivo: "sem_agente" };

  const ofertas = (cfg.data.ofertas ?? ["site"]) as OfertaDaCampanha[];
  // Mesmos fios do envio (voz + vocabulário da org + estratégia): a prévia só
  // vale se for byte a byte o que o tick mandaria. A estratégia vem da MESMA
  // fonte que o worker usa (`estrategiaDoCandidato`).
  const personalizacao = opcoes.personalizacao ?? (await personalizacaoDaOrganizacao(pool, org));
  const estrategia = estrategiaDoCandidato(linha.data, site, {
    ofertas,
    nicho: linha.search?.niche ?? linha.data.category ?? "",
    sobrescritaVocabulario: personalizacao.vocabulario ?? null,
    status: linha.status,
  });
  const gerado = await gerarAbordagemDeFormulario(pool, llmEdgeConfigFromEnv(env), {
    tenantId: org,
    agentId: cfg.data.agent_id,
    leadId: linha.contact_id ?? null,
    instrucao: instrucaoDeAbordagemFria(
      cfg.data.instruction,
      cfg.data.qualification,
      blocoVozVendedor(personalizacao) || undefined,
      estrategia,
      // A mesma regra do envio: a prévia é byte a byte o que o tick mandaria.
      cfg.data.exit_offer !== "first_message",
    ),
    origem: "Pesquisa de empresas",
    origemDaAbordagem: "prospeccao_fria",
    // Modo "saída na 2ª": sem Auditoria/Detalhe, como no envio (worker.ts).
    dados: montarDadosDeAbordagem(linha.data, cfg.data.exit_offer !== "first_message" ? null : site),
  });
  if (!gerado.ok) return { ok: false, motivo: "ia_falhou", detalhe: gerado.reason };

  const score = pontuarCandidato(
    linha.data.rating,
    linha.data.reviews,
    site.classe,
    ofertas[0] ?? "site",
    site.provisorio ?? false,
  );
  // A prévia é ancorada na CHAVE da auditoria (sobre qual veredito ela foi
  // escrita), nunca num instante solto.
  const previa: PreviaSalva = {
    texto: gerado.texto,
    baseada_em: chaveDaAuditoria(linha.data) ?? `${site.classe}@derivado`,
    gerada_em: new Date().toISOString(),
    agente_id: cfg.data.agent_id,
  };
  return { ok: true, texto: gerado.texto, previa, estrategia, score };
}
