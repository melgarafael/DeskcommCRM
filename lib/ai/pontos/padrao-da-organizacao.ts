/**
 * A IA DA EMPRESA, ESCRITA NO PASSO EM QUE A PESSOA ESCOLHE — o padrão da
 * organização (`organizations.settings.llm`).
 *
 * ─── POR QUE ELE EXISTE ────────────────────────────────────────────────────
 *
 * A decisão do dono do produto sobre a #1007: ao escolher um provedor no
 * onboarding e colar a chave dele, **esse passa a ser o provedor da empresa
 * inteira**. Antes disso, o wizard gravava a credencial com o provedor da chave
 * colada e deixava `settings.llm.provider` como estava (o `anthropic` semeado
 * pelo gatilho) — e daí saíam os dois sintomas da issue: o atendente nascia em
 * rascunho pedindo uma chave de outro provedor, e a prova de crédito da tela
 * (`app/onboarding/setup-ai/_inteligencia.tsx`) procurava chave do provedor da
 * EMPRESA, que ninguém escolheu, sobre uma chave que funcionava.
 *
 * ─── O PAR NÃO PODE SER EMPRESTADO PELA METADE ─────────────────────────────
 *
 * `fn_seed_org_llm_defaults` semeia `provider: 'anthropic'` e
 * `default_model: <o curado da Anthropic>` JUNTOS, no INSERT de
 * `organizations` — é por isso que trocar só o `provider` não é uma opção:
 * deixaria o modelo antigo apontando para o endpoint novo, um id que ele não
 * conhece. O modelo sai do catálogo (`ai_models`) do provedor escolhido, pela
 * MESMA régua que a publicação do primeiro atendente usa
 * (`escolherModeloDoProvedor`: o curado vence, e sem curado vale o mais barato
 * que suporta ferramentas). Assim o padrão da empresa e o modelo do funcionário
 * que nasce com ela são o mesmo por construção, não por coincidência.
 * Sem nenhum modelo no catálogo daquele provedor NÃO se grava nada: inventar um
 * id, ou trocar o provedor e manter o modelo antigo, entrega um atendente que
 * responde texto plausível e nunca cria o negócio.
 *
 * ─── AS DUAS ARMADILHAS DE ESCRITA, MEDIDAS NA MAIN ────────────────────────
 *
 * **1. `organizations` só aceita escrita de platform admin.** A única policy de
 * escrita é `orgs_write_platform_admin` (baseline): um UPDATE pelo client de
 * sessão casa ZERO linhas para o admin do próprio tenant e o PostgREST devolve
 * SUCESSO — o wizard diria "gravado" sem nada gravado. Por isso o client é o
 * admin (service role), como no gêmeo `app/api/v1/ai/providers/route.ts` (`PATCH`
 * do padrão da organização, que é a tela onde esse mesmo jsonb se edita à mão).
 * O service role passa por cima da RLS, então o `.eq("id", orgId)` abaixo é a
 * ÚNICA cerca entre "mudei a IA da minha empresa" e "mudei a de toda instalação"
 * — e o `orgId` vem de quem chamou (`requireOnboardingCtx()`, do cookie de
 * sessão), NUNCA do corpo do formulário.
 *
 * **2. `settings` é jsonb COMPARTILHADO.** `branding` (a marca), `security` (a
 * política de MFA), `onboarding_state` e afins moram no mesmo objeto, e um
 * `update({ settings: { llm } })` ingênuo apaga todos em silêncio — o sintoma
 * aparece dias depois, longe daqui. A escrita é MERGE nos dois níveis: no objeto
 * `settings` e dentro de `llm`, cujos `params` e `enabled_models` o turno lê
 * (`lib/agent-engine/edge/llm/credentials.ts`).
 */
import { escolherModeloNoCatalogo } from "@/lib/ai/agents/escolher-modelo";
import { audit } from "@/lib/audit";
import type { createAdminClient } from "@/lib/supabase/admin";

export type ResultadoDoPadrao =
  | {
      ok: true;
      provider: string;
      modelo: string;
      /** De onde o modelo saiu: o marcado como padrão, ou a escolha automática. */
      origem: "curado" | "automatico";
    }
  | {
      ok: false;
      /**
       * `sem_modelo_no_catalogo` é o único que a tela precisa distinguir: é o
       * estado de uma instalação nova (a OpenRouter chega com ZERO linhas até o
       * cron do catálogo rodar), e o conserto é esperar o catálogo, não tentar
       * de novo. Os outros dois são falha nossa.
       */
      motivo: "sem_modelo_no_catalogo" | "leitura_falhou" | "escrita_recusada";
    };

export interface PedidoDePadrao {
  admin: ReturnType<typeof createAdminClient>;
  /** Resolvido da sessão por quem chama — nunca do corpo da requisição. */
  orgId: string;
  actorUserId: string;
  provider: string;
}

export async function definirPadraoDeIaDaOrganizacao(
  p: PedidoDePadrao,
): Promise<ResultadoDoPadrao> {
  const escolha = await escolherModeloNoCatalogo(p.admin, p.provider);
  if (escolha === null) return { ok: false, motivo: "leitura_falhou" };
  if (!escolha.escolhido) return { ok: false, motivo: "sem_modelo_no_catalogo" };

  const { data: orgAtual, error: leituraErr } = await p.admin
    .from("organizations")
    .select("settings")
    .eq("id", p.orgId)
    .maybeSingle();
  if (leituraErr || !orgAtual) return { ok: false, motivo: "leitura_falhou" };

  const settingsAtuais = (orgAtual.settings ?? {}) as Record<string, unknown>;
  const llmAtual = (settingsAtuais.llm ?? {}) as Record<string, unknown>;
  const settings = {
    ...settingsAtuais,
    llm: { ...llmAtual, provider: p.provider, default_model: escolha.modelId },
  };

  const { data: gravado, error: escritaErr } = await p.admin
    .from("organizations")
    .update({ settings })
    .eq("id", p.orgId)
    .select("settings")
    .maybeSingle();
  // Zero linhas volta como SUCESSO no PostgREST: sem esta conferência, o passo
  // diria "gravado" para uma escrita que não aconteceu.
  if (escritaErr || !gravado) return { ok: false, motivo: "escrita_recusada" };

  // Mesma ação de auditoria do PATCH da tela de provedores: é a MESMA mutação
  // (o padrão de IA da organização), vista de outra porta. `origem` é o que
  // separa as duas depois.
  void audit({
    action: "ai.org_default_updated",
    organizationId: p.orgId,
    actorUserId: p.actorUserId,
    resourceType: "organization",
    resourceId: p.orgId,
    metadata: {
      provider: p.provider,
      default_model: escolha.modelId,
      origem: "onboarding",
    },
  });

  return { ok: true, provider: p.provider, modelo: escolha.modelId, origem: escolha.origem };
}
