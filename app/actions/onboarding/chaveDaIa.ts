"use server";

/**
 * A CHAVE DA INTELIGÊNCIA, PEDIDA ONDE ELA FALTA.
 *
 * O passo 1 já MEDE se a instalação trouxe chave, e quando não trouxe escrevia
 * "Falta a chave da inteligência artificial" — um diagnóstico correto e um beco:
 * a pessoa lê que falta e não tem o que fazer com a informação. Ela teria de
 * descobrir sozinha que existe uma tela de credenciais, e onde.
 *
 * Aqui ela cola a chave no passo em que a chave passa a importar — o de treinar,
 * imediatamente antes de o funcionário ser criado com ela.
 *
 * ⚠️ A ESCOLHA FEITA AQUI VALE PARA A EMPRESA INTEIRA. Quem cola a chave está
 * respondendo "qual inteligência artificial vai atender seus clientes", e essa
 * resposta passa a valer em todo ponto de IA que não tenha escolha própria
 * (`organizations.settings.llm`, o degrau 5 de `lib/ai/pontos/resolver.ts`).
 * Sem esta gravação o wizard mentia duas vezes: o atendente nascia pedindo
 * chave de um provedor que ninguém escolheu, e a prova de crédito da própria
 * tela procurava a chave no provedor errado — sobre uma chave que funcionava
 * (#1007). A regra mora em `lib/ai/pontos/padrao-da-organizacao.ts`.
 *
 * ⚠️ O MIOLO NÃO MORA AQUI. Cifrar, gravar, auditar e validar é
 * `lib/ai/credenciais/guardar.ts`, o mesmo caminho que a rota REST usa: cada
 * item dessa lista tem consequência de segurança se as duas cópias divergirem.
 */
import { revalidatePath } from "next/cache";

import { createAdminClient } from "@/lib/supabase/admin";
import { guardarCredencial } from "@/lib/ai/credenciais/guardar";
import { definirPadraoDeIaDaOrganizacao } from "@/lib/ai/pontos/padrao-da-organizacao";
import { IDS_DE_PROVEDOR } from "@/lib/ai/pontos/provedores";
import { requireOnboardingCtx, OnboardingError } from "./_shared";

export type ResultadoDaChave =
  | {
      ok: true;
      final: string;
      /**
       * O par que passou a valer para a empresa. `null` quando não deu para
       * gravar — a chave está salva do mesmo jeito, e `aviso` diz à tela o que
       * não aconteceu. Gravar o `provider` sem o modelo pareado seria pior que
       * não gravar: mandaria um id de modelo da Anthropic para o endpoint do
       * provedor novo.
       */
      padrao: { provider: string; modelo: string } | null;
      /**
       * Por que o padrão da empresa NÃO mudou, quando não mudou.
       * `sem_modelo_no_catalogo` é o estado de uma instalação nova (o catálogo
       * de um provedor agregador só chega no cron diário) e pede esperar; o
       * outro é falha nossa e pede tentar de novo na tela de provedores.
       */
      aviso?: "sem_modelo_no_catalogo" | "nao_gravou";
    }
  | { ok: false; erro: string };

export async function salvarChaveDaIa(formData: FormData): Promise<ResultadoDaChave> {
  let ctx;
  try {
    ctx = await requireOnboardingCtx();
  } catch (err) {
    if (err instanceof OnboardingError) return { ok: false, erro: "Sua sessão expirou. Entre de novo." };
    throw err;
  }

  // Guardar chave de provedor é ação de administrador, igual à rota REST. Quem
  // faz o onboarding é o dono, mas o papel é verificado e não presumido.
  if (ctx.role !== "admin") {
    return { ok: false, erro: "Só um administrador pode cadastrar a chave da inteligência artificial." };
  }

  const provider = String(formData.get("provider") ?? "");
  if (!(IDS_DE_PROVEDOR as readonly string[]).includes(provider)) {
    return { ok: false, erro: "Escolha qual inteligência artificial você contratou." };
  }

  const apiKey = String(formData.get("api_key") ?? "").trim();
  if (apiKey.length < 8) {
    return { ok: false, erro: "Essa chave parece incompleta. Cole a chave inteira, do começo ao fim." };
  }

  // Um cliente só para as duas escritas. As duas são service role (a policy de
  // escrita de `organizations` é `orgs_write_platform_admin`, e a credencial é
  // cifrada por aqui de propósito), e as duas são cercadas por `orgId` resolvido
  // da SESSÃO por `requireOnboardingCtx` — nunca do corpo do formulário, que
  // traria o `organization_id` de outra empresa se alguém o acrescentasse.
  const admin = createAdminClient();

  const r = await guardarCredencial({
    admin,
    orgId: ctx.orgId,
    userId: ctx.userId,
    provider: provider as (typeof IDS_DE_PROVEDOR)[number],
    // O nome existe para a pessoa reconhecer a chave depois, na tela de
    // credenciais — não é identificador.
    label: "Chave do onboarding",
    apiKey,
  });

  if (!r.ok) {
    if (r.motivo === "label_em_uso") {
      return {
        ok: false,
        erro: "Já existe uma chave cadastrada com esse nome. Veja em IA › Credenciais.",
      };
    }
    return { ok: false, erro: "Não consegui guardar a chave agora. Tente de novo." };
  }

  // A chave está salva. A escolha do provedor passa a valer para a empresa
  // inteira — e é AQUI, no passo em que ela foi feita, que isso se grava: se a
  // publicação adotasse por conta própria o provedor de outra credencial, o
  // provedor do atendente e o da empresa divergiriam em silêncio, que é o
  // defeito de origem com outra roupa.
  const padrao = await definirPadraoDeIaDaOrganizacao({
    admin,
    orgId: ctx.orgId,
    actorUserId: ctx.userId,
    provider,
  });

  // O passo lê o retrato da instalação no servidor; sem invalidar, ele seguiria
  // dizendo que falta a chave que acabou de ser cadastrada — e continuaria
  // mostrando o provedor antigo.
  revalidatePath("/onboarding", "layout");

  // A chave salva é o desfecho principal e não pode virar erro por causa do
  // padrão da empresa: quem colou a chave tem uma credencial utilizável, e
  // mandá-la colar de novo por um segundo problema seria perder as duas.
  if (padrao.ok) {
    return { ok: true, final: r.last4, padrao: { provider: padrao.provider, modelo: padrao.modelo } };
  }
  return {
    ok: true,
    final: r.last4,
    padrao: null,
    aviso: padrao.motivo === "sem_modelo_no_catalogo" ? "sem_modelo_no_catalogo" : "nao_gravou",
  };
}
