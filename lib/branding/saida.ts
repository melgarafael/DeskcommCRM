/**
 * A marca nas saídas SEM DOM — e-mail, autenticador, remetente, suporte.
 *
 * ── E na fachada de acesso, que tem DOM e mesmo assim vem aqui ────────────────
 *
 * `app/(public)/layout.tsx` (login, cadastro, recuperação, MFA) também chama
 * `marcaDaSaida(null)`, e isso não contradiz o nome deste módulo: o que aquela
 * casca precisa é exatamente o que ele entrega — UM nome e UM logo, da pilha
 * instalação → `.env`, de um resolvedor que nunca lança. Cor ela não usa: quem
 * pinta aquelas telas é o `<style id="marca-instalacao">` do layout raiz. O que
 * NÃO pode acontecer é a fachada montar a própria pilha e anunciar uma
 * precedência que o resto do produto não usa.
 *
 * ── Por que este seam existe ─────────────────────────────────────────────────
 *
 * `app/layout.tsx:51-62` monta a pilha e devolve `MarcaResolvida`, que carrega
 * a rampa de 11 stops nos DOIS temas, os tokens de cada papel e a lista de
 * motivos. Isso é o que o CSS precisa. E-mail e PDF não têm CSS, não têm
 * cascata e não têm tema: precisam de UM hex e de UMA frente legível. Entregar
 * `MarcaResolvida` a um template de e-mail obrigaria cada template a escolher
 * tema e a cavar `cor?.derivada?.claro.accent` — e o dia em que um deles
 * cavasse `escuro` ninguém perceberia, porque nenhum gate lê cor de e-mail.
 *
 * ── TEMA CLARO, SEMPRE ───────────────────────────────────────────────────────
 *
 * E-mail não tem tema. A maioria dos clientes pinta fundo branco atrás do
 * corpo, e `prefers-color-scheme` dentro de e-mail não é confiável (Gmail web
 * descarta media query em boa parte dos casos). Escolher o tema claro é a única
 * decisão que não depende de adivinhar o cliente de quem recebe.
 *
 * ── NUNCA LANÇA — e aqui isso não é zelo ─────────────────────────────────────
 *
 * Mesmo contrato de `lib/branding/instalacao.ts:230-241`, por um motivo mais
 * duro: quem chama isto é o e-mail de LGPD, que responde a um direito legal do
 * titular com SLA de D+7 (`docs/prd/01-prd-platform-base.md`, e o alarme em
 * `lib/lgpd/sla-alarm.ts`). Um envio que falha porque a LEITURA DA COR deu erro
 * troca um problema estético por um descumprimento de prazo legal. Em qualquer
 * falha — banco fora do ar, tabela ausente, jsonb corrompido — esta função
 * degrada para o padrão do produto e segue.
 *
 * Não é engolir erro: a recusa sai no log estruturado, e a resolução da cor
 * continua devolvendo `motivos` por dentro (`resolve.ts`), que é o que a tela
 * `/admin/marca` mostra ao operador.
 */

import { DEFAULT_APP_NAME } from "@/lib/branding";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

import { melhorFrenteSobre } from "./contraste";
import { marcaDaInstalacao } from "./instalacao";
import { resolverMarcaDaOrganizacao } from "./organizacao";
import { stop } from "./rampa";
import { REGUA_DO_PRODUTO } from "./regua-do-produto";
import { camadaDaInstalacao, camadaDoAmbiente, resolverMarca } from "./resolve";

export type MarcaDeSaida = {
  readonly nome: string;
  /**
   * `null` = não há logo configurado, e quem renderiza NÃO desenha nada no
   * lugar. Ficou sem leitor nenhum desde que este seam nasceu — os dois
   * consumidores entraram nesta onda: o topo do convite de time
   * (`lib/email/templates/invite.ts`) e a casca das telas de acesso
   * (`app/(public)/layout.tsx`).
   */
  readonly logoUrl: string | null;
  /** `#hex` sempre — o formato que cliente de e-mail e @react-pdf entendem. */
  readonly accent: string;
  /** Preto ou branco, já com o piso de contraste aplicado. */
  readonly accentFg: string;
  /** De qual camada veio cada campo. `padrao` = ninguém configurou. */
  readonly origens: { readonly nome: string; readonly cor: string };
};

/**
 * O accent do tema CLARO do produto — LIDO da régua, nunca redigitado.
 *
 * `REGUA_DO_PRODUTO.claro.indices.accent` é 6 (`regua-do-produto.ts:175`) e o
 * grau 600 da rampa do produto é `#008069` (`:34`). Escrever `"#008069"` aqui
 * criaria a QUARTA cópia do mesmo hex no repositório (as outras vivem em
 * `regua-do-produto.ts`, `app/globals.css` e na rampa derivada), e nada as
 * manteria em sincronia — o dia em que o produto mudar de cor, o botão dos
 * e-mails ficaria com a cor velha e nenhum teste reprovaria.
 *
 * `stop()` e não `[6]`: sob `noUncheckedIndexedAccess`, indexar a tupla com um
 * `number` devolveria `string | undefined`, e o `!` para calar isso é
 * exatamente o cast que a doutrina proíbe.
 */
const ACCENT_DO_PRODUTO = stop(
  REGUA_DO_PRODUTO.rampaDoProduto,
  REGUA_DO_PRODUTO.claro.indices.accent,
);

/**
 * Os neutros do tema claro, para o texto que NÃO é o botão.
 *
 * Existe para que um template de e-mail nunca precise digitar um hex. Antes
 * disto cada template tinha a própria paleta cinza inventada (`#111827`,
 * `#6b7280`, `#1c1917`, `#57534e`, `#78716c` — cinco tons de dois sistemas
 * diferentes em três arquivos), e o corpo do e-mail não parecia o produto.
 * Os índices são os mesmos que `app/globals.css` usa para texto e texto suave.
 */
export const NEUTROS_DE_SAIDA = {
  /** Corpo do texto. */
  texto: stop(REGUA_DO_PRODUTO.claro.neutros, 9),
  /** Rodapé, legenda, aviso — o que não é a mensagem principal. */
  suave: stop(REGUA_DO_PRODUTO.claro.neutros, 5),
  /** Fundo da página do e-mail. */
  fundo: stop(REGUA_DO_PRODUTO.claro.neutros, 0),
  /** Régua e borda. */
  linha: stop(REGUA_DO_PRODUTO.claro.neutros, 2),
} as const;

/** O que sobra quando nada pôde ser lido. Uma instalação funcionando. */
function padraoDoProduto(): MarcaDeSaida {
  return {
    nome: DEFAULT_APP_NAME,
    logoUrl: null,
    accent: ACCENT_DO_PRODUTO,
    accentFg: melhorFrenteSobre(ACCENT_DO_PRODUTO),
    origens: { nome: "padrao", cor: "padrao" },
  };
}

/**
 * Avisos já registrados neste processo — mesmo desenho de `instalacao.ts:223`.
 * Sem isto, um banco fora do ar encheria o log com uma linha por e-mail.
 */
const avisosRegistrados = new Set<string>();

function avisarUmaVez(chave: string, mensagem: string, contexto: Record<string, unknown>): void {
  if (avisosRegistrados.has(chave)) return;
  avisosRegistrados.add(chave);
  logger.warn(mensagem, contexto);
}

/**
 * O `settings` da organização, cru. `null` = "não deu para ler" E TAMBÉM
 * "a organização não fala de marca" — as duas descem para a camada de baixo,
 * que é o comportamento certo nos dois casos (`camadaDaOrganizacao` trata
 * `null` como camada que não fala de nada, `resolve.ts:466-471`).
 */
async function settingsDaOrganizacao(organizationId: string): Promise<unknown> {
  const { data, error } = await createAdminClient()
    .from("organizations")
    .select("settings")
    .eq("id", organizationId)
    .maybeSingle();
  if (error) {
    avisarUmaVez(
      `organizacao|${error.code ?? "?"}`,
      "marca de saída: não deu para ler a marca da organização; vale a da instalação",
      { codigo: error.code, detalhe: error.message },
    );
    return null;
  }
  return data?.settings ?? null;
}

/**
 * A marca que vai numa saída sem DOM.
 *
 * `organizationId !== null` → pilha completa (organização → instalação → `.env`
 * → padrão). É a CLASSE A: o convite de time e o e-mail de LGPD dizem quem
 * atendeu, e no produto do revendedor quem atende é o cliente dele.
 *
 * `organizationId === null` → instalação → `.env` → padrão. É a CLASSE B: as
 * saídas anteriores a qualquer organização (cadastro de MFA, e-mail de auth).
 * Passar `null` não é omissão — é a declaração de que ainda não há organização.
 *
 * A CLASSE C (não leva marca nenhuma) não chama esta função: é o PDF de LGPD,
 * e o motivo está escrito em `lib/lgpd/pdf-renderer.tsx`.
 *
 * A leitura da instalação é memoizada por 30s (`instalacao.ts:209`) e a
 * invalidação da escrita alcança o MESMO processo — porque quem envia e-mail é
 * o app, via `event-log-drain`, e não o contêiner `worker` (medido:
 * `lib/event-log/register-handlers.ts:12` é importado só por
 * `app/api/v1/cron/event-log-drain/route.ts:21`; `Dockerfile.worker` roda
 * `workers/agent-worker/main.ts`, que não importa e-mail nenhum).
 */
export async function marcaDaSaida(organizationId: string | null): Promise<MarcaDeSaida> {
  try {
    const linha = await marcaDaInstalacao();
    const marca =
      organizationId === null
        ? resolverMarca([camadaDaInstalacao(linha), camadaDoAmbiente(env)], REGUA_DO_PRODUTO)
        : resolverMarcaDaOrganizacao(await settingsDaOrganizacao(organizationId), linha, env);

    // `claro`, sempre — ver o cabeçalho. `derivada` é `null` quando a semente
    // não pinta (cor acromática, papel só de identidade, hex recusado): aí o
    // accent do produto é a resposta certa, e não a semente crua, que nesses
    // casos é justamente a cor que o derivador se recusou a usar.
    const derivada = marca.cor?.derivada ?? null;
    const accent = derivada?.claro.accent ?? ACCENT_DO_PRODUTO;

    return {
      nome: marca.name,
      logoUrl: marca.logoUrl,
      accent,
      // Nunca `#ffffff` fixo: `melhorFrenteSobre` (`contraste.ts:79`) já
      // decide preto ou branco pelo contraste real. Uma marca amarela colada
      // pelo revendedor produziria texto branco ilegível no botão — e é
      // exatamente a marca que se cola sem avisar ninguém.
      accentFg: derivada?.claro.accentFg ?? melhorFrenteSobre(accent),
      origens: {
        nome: marca.origens.nome,
        // Sem derivação a cor EXIBIDA é a do produto, mesmo que alguma camada
        // tenha declarado uma semente. Reportar a camada aqui faria o
        // diagnóstico dizer "a cor veio do banco" enquanto o botão está verde
        // do produto.
        cor: derivada ? marca.origens.cor : "padrao",
      },
    };
  } catch (erro) {
    avisarUmaVez("resolucao|excecao", "marca de saída: resolução falhou; vale o padrão do produto", {
      detalhe: erro instanceof Error ? erro.message : String(erro),
    });
    return padraoDoProduto();
  }
}

/**
 * O e-mail de suporte que a instalação mostra ao cliente final.
 *
 * String VAZIA significa "ninguém configurou", e quem chama NÃO renderiza
 * endereço nenhum. Cair no nosso endereço seria o defeito de volta: numa tela
 * de conta suspensa, quem suspendeu foi o revendedor — mandar o cliente dele
 * escrever para nós entrega o cliente e não resolve o problema dele.
 *
 * Só o `.env` por enquanto. A coluna que permitiria trocar isto pela tela
 * (`platform_branding.support_email`) exige migration + apêndice no
 * `baseline.sql`, e schema não entra nesta mudança — está declarado no handoff
 * desta fase. Quando entrar, esta função ganha a linha do banco ACIMA do
 * ambiente, na mesma ordem que a marca já usa.
 */
export function emailDeSuporte(): string {
  return env.SUPPORT_EMAIL.trim();
}
