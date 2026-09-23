/**
 * Configurações → Conversões. Onde o dono do tráfego conecta a conta de anúncios
 * e vê quais vendas foram (ou não foram) reportadas de volta.
 *
 * ── Por que esta tela nasce JUNTO com o mecanismo, e não depois ──────────────
 *
 * Invariante 6 da doutrina de restrição de canal: "nenhum mecanismo de backend
 * pode depender de estado configurável que não tenha tela para ver, tela para
 * mudar, e caminho visível de falha". A #144 mediu o preço de ignorar isso —
 * rodízio e visibilidade por atendente existiam INTEIROS, sem tela, e um
 * contribuidor abriu issue pedindo a feature que já estava construída.
 *
 * O handler de conversões teria caído no mesmo buraco, e pior: a falha mais
 * comum dele (`sem_valor`) é ACIONÁVEL por quem opera. Sem esta lista, "a Meta
 * não recebe minhas vendas" não teria resposta em lugar nenhum do produto.
 *
 * ── Por que ADMIN CLIENT para ler, diferente de `settings/marca` ─────────────
 *
 * A tela da marca lê `organizations` pelo client de sessão, porque a RLS
 * entrega essa linha a qualquer membro. Aqui não existe policy nenhuma:
 * `ad_platform_connections` e `ad_conversion_dispatches` têm RLS ligada com ZERO
 * policies e grants revogados de anon/authenticated (0204), exatamente para não
 * serem alcançáveis pela anon key que vai para o browser. Pelo client de sessão
 * esta página mostraria vazio para todo mundo — o gate de papel acima é o que
 * autoriza, e a leitura privilegiada acontece no servidor.
 *
 * ── Por que `admin`, e não `manager` ────────────────────────────────────────
 *
 * O objeto é uma credencial que escreve na conta de anúncios da empresa, ao lado
 * de billing e API tokens na mesma prancheta. Mesmo gate de `settings/marca`.
 */
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import {
  contaEnviadas,
  lerEstadoDaConexao,
  lerPendencias,
  MOTIVO_LEGIVEL,
} from "@/lib/conversoes/estado-da-conexao";
import { listSelectableChannels } from "@/lib/channels/selectable";
import { traduzir } from "@/lib/i18n/dicionario";
import {
  CHAVES_DE_UTM,
  montarCodigoDeOrigemDoSite,
  TAMANHO_MAXIMO_DO_CODIGO,
} from "@/lib/leads/origem-do-site";
import { formatCentsBRL } from "@/lib/money";
import {
  faltaParaConectarOGoogleAds,
  googleAdsEstaConfigurado,
} from "@/lib/plataformas-de-anuncio/google/config";
import { lerEstadoDaConexaoGoogle } from "@/lib/plataformas-de-anuncio/google/estado-da-conexao";
import { lerEstadoDaCaptura } from "@/lib/plataformas-de-anuncio/landing-config";
import { createAdminClient } from "@/lib/supabase/admin";

import { FormularioDeCapturaDeUtm } from "./_formCapturaDeUtm";
import { FormularioDeConversoes } from "./_form";
import { FormularioDeConversoesGoogle } from "./_formGoogle";

export const metadata = { title: "Conversões" };
export const dynamic = "force-dynamic";

/** O que a volta do OAuth do Google Ads diz, traduzido — ver o callback. */
const ERRO_DO_GOOGLE_EM_PORTUGUES: Record<string, string> = {
  cancelado: "Você cancelou a autorização no Google. Nada foi conectado.",
  estado_invalido: "O link de conexão expirou ou é inválido. Clique em \"Conectar com Google\" de novo.",
  sem_codigo: "O Google não devolveu o código esperado. Tente de novo.",
  google_ads_nao_configurado:
    "Esta instalação ainda não tem as credenciais do Google Ads configuradas. Fale com quem administra o servidor.",
  troca_falhou: "Não consegui trocar o código pelo token de acesso. Tente conectar de novo.",
  sem_refresh_token:
    "O Google não devolveu a autorização de longa duração esperada. Tente conectar de novo.",
  cifra_indisponivel:
    "Esta instalação está sem a chave mestra de criptografia, e o token não foi gravado. Quem instalou o sistema precisa configurá-la.",
  erro_ao_gravar: "Não consegui gravar a conexão agora. Tente de novo em instantes.",
};

export default async function ConversoesPage({
  searchParams,
}: {
  searchParams: Promise<{ erro?: string; ok?: string }>;
}) {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (!(user.is_platform_admin && !user.support) && ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    redirect("/403");
  }
  const { erro: erroDoGoogle, ok: okDoGoogle } = await searchParams;

  const admin = createAdminClient();
  const [estado, pendencias, enviadas, estadoGoogle, estadoDaCaptura, canais, organizacao] =
    await Promise.all([
      lerEstadoDaConexao(admin, activeOrg.orgId),
      lerPendencias(admin, activeOrg.orgId),
      contaEnviadas(admin, activeOrg.orgId),
      lerEstadoDaConexaoGoogle(admin, activeOrg.orgId),
      lerEstadoDaCaptura(admin, "meta_ads_landing_pages", activeOrg.orgId),
      // Os números conectados viram SUGESTÃO no formulário de captura. Falhar
      // aqui não pode derrubar a tela inteira: sem sugestão, a pessoa digita.
      listSelectableChannels(admin, activeOrg.orgId).catch(() => []),
      // O `slug` é o `[org]` da rota pública, e não está no `ActiveOrg`.
      admin.from("organizations").select("slug").eq("id", activeOrg.orgId).maybeSingle(),
    ]);
  const slug = (organizacao.data as { slug: string | null } | null)?.slug ?? null;
  const numerosConectados = canais
    .map((c) => c.phone_number)
    .filter((n): n is string => Boolean(n));
  const idioma = user.idioma;
  const t = (texto: string) => traduzir(texto, idioma);

  /**
   * O exemplo do link é GERADO aqui, e não escrito à mão.
   *
   * Um exemplo fixo envelhece: no dia em que o contrato mudar, a tela passa a
   * ensinar um link que a ingestão não reconhece — e o defeito só apareceria na
   * atribuição de quem seguiu a instrução, meses depois. Gerando pelo mesmo
   * módulo que a ingestão lê, o exemplo é verdadeiro por construção.
   */
  const codigoDeExemplo =
    montarCodigoDeOrigemDoSite({ utm_source: "instagram", utm_campaign: "promo-junina" }) ?? "";
  const linkDeExemplo = `https://wa.me/5511999999999?text=${encodeURIComponent(
    `${t("Olá! Vim pelo site.")} ${codigoDeExemplo}`.trim(),
  )}`;

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Conversões")}</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {t(
            "Quando um negócio que veio de anúncio é marcado como ganho, o valor da venda volta para a plataforma que trouxe o cliente. É esse retorno que ensina o anúncio a procurar mais gente parecida com quem comprou.",
          )}
        </p>
      </header>

      {erroDoGoogle && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm">
          {t(ERRO_DO_GOOGLE_EM_PORTUGUES[erroDoGoogle] ?? "Não consegui conectar com o Google Ads.")}
        </div>
      )}
      {okDoGoogle && (
        <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-4 text-sm">
          {t("Google Ads autorizado. Agora informe a conta e a ação de conversão abaixo.")}
        </div>
      )}

      {estado.conectada && !estado.habilitada && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
          {t("O envio está pausado. As vendas continuam sendo registradas aqui, mas não vão para a plataforma enquanto isto estiver desligado.")}
        </div>
      )}

      {estado.testEventCode && (
        <div className="rounded-md border border-sky-500/40 bg-sky-500/10 p-4 text-sm">
          {t("Modo de teste ligado: as vendas vão marcadas como teste e não contam para a otimização. Apague o código de teste quando terminar de conferir.")}
        </div>
      )}

      <FormularioDeConversoes estado={estado} idioma={idioma} />
      <FormularioDeConversoesGoogle
        estado={estadoGoogle}
        idioma={idioma}
        configurado={googleAdsEstaConfigurado()}
        falta={faltaParaConectarOGoogleAds()}
      />

      <section className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-semibold">{t("Vendas que não foram reportadas")}</h2>
          <span className="text-sm text-muted-foreground">
            {enviadas} {t("reportadas com sucesso")}
          </span>
        </div>

        {pendencias.length === 0 ? (
          <p className="rounded-md border p-4 text-sm text-muted-foreground">
            {/*
              Ausência de pendência tem DUAS causas com significados opostos, e
              dizer só "tudo certo" esconderia a segunda: ou nada falhou, ou nunca
              fechou uma venda vinda de anúncio. Quem acabou de conectar precisa
              saber que a lista vazia ainda não prova que funciona.
            */}
            {t("Nenhuma pendência. Ou tudo que veio de anúncio foi reportado, ou ainda não fechou nenhuma venda com origem em anúncio.")}
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th className="p-3 font-medium">{t("Negócio")}</th>
                  <th className="p-3 font-medium">{t("Valor")}</th>
                  <th className="p-3 font-medium">{t("O que houve")}</th>
                  <th className="p-3 font-medium">{t("Quando")}</th>
                </tr>
              </thead>
              <tbody>
                {pendencias.map((p) => (
                  <tr key={p.leadId} className="border-t align-top">
                    <td className="p-3">
                      <a className="underline underline-offset-2" href={`/app/kanban?lead=${p.leadId}`}>
                        {p.tituloDoLead ?? t("(sem título)")}
                      </a>
                    </td>
                    <td className="p-3 whitespace-nowrap">
                      {p.valorCentavos === null ? "—" : formatCentsBRL(p.valorCentavos)}
                    </td>
                    <td className="p-3">
                      <span>{t(MOTIVO_LEGIVEL[p.motivo ?? ""] ?? p.motivo ?? "—")}</span>
                      {p.detalhe && (
                        <span className="mt-1 block text-xs text-muted-foreground">{p.detalhe}</span>
                      )}
                    </td>
                    <td className="p-3 whitespace-nowrap text-muted-foreground">
                      {new Date(p.tentadoEm).toLocaleString(idioma)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/*
        Condição 3 da decisão da #924: "quem opera encontra a explicação de como
        montar o link do WhatsApp com o código".

        Mora nesta tela porque esta é a tela da atribuição — a mesma que já
        responde "a Meta recebeu minhas vendas?". O mecanismo do site não tem
        outra superfície: sem este texto, o contrato do link existiria só no
        código, e quem monta o botão da landing page não teria onde descobrir o
        formato nem os limites.
      */}
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">{t("Quem chegou pelo site")}</h2>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {t(
            "Quando a pessoa vê a campanha numa página sua e toca num botão que abre o WhatsApp, o link desse botão pode levar a origem junto. O código abaixo vai no texto da mensagem, e a conversa entra no CRM já com a origem do site.",
          )}
        </p>

        <div className="rounded-md border p-4 text-sm">
          <p className="font-medium">{t("Como montar o link do botão")}</p>
          <ol className="mt-2 flex list-decimal flex-col gap-2 pl-5">
            <li>
              {t(
                "Monte o texto que a pessoa vai enviar — uma saudação basta — e termine com o código.",
              )}
            </li>
            <li>
              {t(
                "Troque o número pelo WhatsApp da empresa e o texto pelo seu, mantendo o código no fim:",
              )}
            </li>
          </ol>
          <code className="mt-3 block overflow-x-auto rounded-md bg-muted/50 p-2 text-xs break-all">
            {linkDeExemplo}
          </code>
          {/*
            A LISTA DE CHAVES VEM DO MÓDULO, e não da frase — mesma razão que o
            exemplo logo acima é gerado e não escrito à mão. Enquanto os nomes
            moravam dentro do texto traduzido, acrescentar uma chave exigia
            lembrar de dois arquivos, e esquecer o segundo deixava a tela
            ensinando uma lista incompleta em português e em espanhol.

            O nome entra FORA do `t()` de propósito: `traduzir()` casa a string
            EXATA, e um template literal não casaria chave nenhuma.
          */}
          <p className="mt-3 text-xs text-muted-foreground">
            {t("Este exemplo foi gerado por esta tela. Os campos que o código aceita são:")}{" "}
            {CHAVES_DE_UTM.join(", ")}.
          </p>
        </div>

        {/*
          O endereço de captura é o caminho RECOMENDADO, e o código acima
          continua valendo: quem já montou link com ele não precisa mexer em
          nada. A diferença é quem monta o marcador — lá é a página, aqui é o
          servidor, e por isso só este dispensa script.
        */}
        {slug ? (
          <FormularioDeCapturaDeUtm
            estado={estadoDaCaptura}
            idioma={idioma}
            slug={slug}
            numerosConectados={numerosConectados}
          />
        ) : (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
            {t("Esta organização ainda não tem um apelido de URL, e o endereço de captura precisa de um. Fale com quem administra o servidor.")}
          </div>
        )}

        <ul className="flex max-w-2xl list-disc flex-col gap-2 pl-5 text-sm text-muted-foreground">
          <li>
            {t(
              "O código vale só na primeira mensagem do contato: quem recebe um link encaminhado não ganha a origem de quem encaminhou.",
            )}
          </li>
          <li>
            {t(
              "Ele nunca sobrescreve uma origem já gravada, inclusive a de anúncio: quem chegou do Meta ou do Google antes mantém o anúncio.",
            )}
          </li>
          <li>
            {t(
              "Só campos de campanha viajam no código, e nenhum dado pessoal: nome, telefone, e-mail e documento ficam de fora.",
            )}{" "}
            {t("O código inteiro tem um teto de")} {TAMANHO_MAXIMO_DO_CODIGO} {t("caracteres.")}
          </li>
          <li>
            {t(
              'A origem aparece na ficha do contato e no filtro "Site (landing page)" da lista de contatos.',
            )}
          </li>
        </ul>
      </section>
    </div>
  );
}
