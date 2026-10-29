/**
 * Semente do módulo "Modelos de proposta" (Configurações › Modelos de proposta).
 *
 * A tela só existe com Propostas ligado nos DOIS níveis: o módulo da instalação
 * (`platform_config.MODULO_PROPOSTAS`, o que `gravarModulo` grava) e a chave da
 * empresa (`organizations.settings.proposals.enabled`, o que o PATCH de
 * Configurações › Propostas grava por merge). A base devolve as duas ao estado de
 * fábrica antes de cada lição, então ligamos aqui a cada vez.
 *
 * Cria um modelo da empresa ("Pacote de nutrição — 3 meses") e apaga, antes, o
 * que as lições criam pela tela: o modelo em branco da fisioterapia e a cópia
 * personalizada de "Projeto personalizado".
 */
import { type Contexto, exigir, semErro } from "../semear-demonstracao";

const MODELO_DA_CLINICA = "empresa_pacote_de_nutricao_3_meses";
/** Slugs que as lições gravam pela tela — somem antes de cada lição. */
const DAS_LICOES = ["empresa_plano_de_tratamento_fisioterapia", "projeto_personalizado"];

const secao = (id: string, title: string, body: string, conditional = false) => ({
  id, title, title_es: null, body, body_es: null, required: !conditional, conditional,
});

const SECOES = [
  secao("resumo", "Resumo", "Esta proposta apresenta o {{project.name}} para {{client.name}}, com acompanhamento da Dra. Lívia Andrade, nutricionista da Clínica Bem Viver."),
  secao("objetivo", "Objetivo do acompanhamento", "Objetivo combinado na primeira conversa: {{project.objective}}."),
  secao("incluido", "O que está incluído", "{{included.list}}"),
  secao("nao_incluido", "O que não está incluído", "{{excluded.list}}", true),
  secao("investimento", "Investimento", "Valor total: {{investment.total_formatted}}. Esta proposta vale {{commercial_terms.validity_days}} dias."),
];

export async function semear(c: Contexto) {
  const { db, org, pessoa } = c;
  semErro(
    await db.from("platform_config").upsert(
      { chave: "MODULO_PROPOSTAS", valor: "ligado", eh_segredo: false, semeado_do_env: false, updated_by: pessoa.helena },
      { onConflict: "chave" },
    ),
    "ligar o módulo Propostas",
  );
  const linha = exigir(await db.from("organizations").select("settings").eq("id", org).single(), "settings") as { settings: Record<string, unknown> | null };
  const settings = linha.settings ?? {};
  const proposals = (settings.proposals as Record<string, unknown> | undefined) ?? {};
  semErro(
    await db.from("organizations").update({ settings: { ...settings, proposals: { ...proposals, enabled: true } } }).eq("id", org),
    "ligar as propostas da empresa",
  );

  semErro(
    await db.from("proposal_templates").delete().eq("organization_id", org).in("slug", [MODELO_DA_CLINICA, ...DAS_LICOES]),
    "limpar modelos",
  );
  semErro(
    await db.from("proposal_templates").insert({
      organization_id: org, slug: MODELO_DA_CLINICA, version: 1, base_slug: null, base_version: null,
      nome: "Pacote de nutrição — 3 meses",
      descricao: "Acompanhamento nutricional com consultas mensais e plano alimentar.",
      sections: SECOES, section_order: SECOES.map((s) => s.id), is_active: true,
    }),
    "modelo da clínica",
  );
}
