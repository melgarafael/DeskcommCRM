import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { nomeDoOperador, resolverOperador } from "@/lib/legal/operador";
import { createClient } from "@/lib/supabase/server";
import { idiomaDoVisitante } from "@/lib/i18n/idiomaAnonimo";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Política de Privacidade" };

export default async function PrivacyPage() {
  const op = await resolverOperador();

  // O operador publicou a política dele: é a dele que vale. Sem isto, o campo
  // `privacy_policy_url` da tela de Organização continuaria sendo um controle
  // que o produto oferece e o código ignora. A URL já vem checada — valor cru
  // do banco nunca chega a um redirect.
  if (op.politicaPropria) redirect(op.politicaPropria);

  const operador = nomeDoOperador(op);

  // Rota fora da árvore de `app/app/layout.tsx` — sem `IdiomaProvider`, então
  // resolve o idioma direto, como `admin/forbidden/page.tsx`. Página legal
  // pública: pode ser lida sem sessão, por isso `user` é opcional.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const idioma = await idiomaDoVisitante(
    (user?.user_metadata?.locale as string | undefined) ?? null,
  );
  const t = (texto: string) => traduzir(texto, idioma);

  return (
    <>
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t("Política de Privacidade")}</h1>
        <p className="text-muted-foreground">
          {t("Como esta instalação do")} {op.sistema} {t("trata dados pessoais.")}
        </p>
      </header>

      <section className="space-y-2">
        <h2 className="text-base font-semibold">{t("1. Quem é o controlador")}</h2>
        <p>
          {t("O controlador dos dados tratados aqui é")} <strong>{operador}</strong>
          {op.cnpj ? ` (CNPJ ${op.cnpj})` : ""} —{" "}
          {t(
            "quem instalou e opera este sistema. Os autores do software não têm acesso a este servidor nem aos dados guardados nele, e não são controladores nem operadores desses dados.",
          )}
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold">{t("2. Que dados são tratados")}</h2>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong>{t("De quem é atendido:")}</strong>{" "}
            {t(
              "nome, telefone, e-mail quando informado, conteúdo das conversas, arquivos enviados (imagens, áudios, documentos) e o histórico de negócios.",
            )}
          </li>
          <li>
            <strong>{t("De quem usa o sistema:")}</strong>{" "}
            {t("nome, e-mail, papel de acesso e registro das ações realizadas.")}
          </li>
        </ul>
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold">{t("3. Para que são usados")}</h2>
        <p>
          {t(
            "Para atender, responder, registrar o andamento do atendimento e organizar a relação comercial — inclusive por agentes de inteligência artificial que atuam sob as regras configuradas pelo operador. Registros de ação são mantidos para auditoria e segurança.",
          )}
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold">{t("4. Com quem são compartilhados")}</h2>
        <p>
          {t(
            "Os dados ficam no servidor do operador. Para funcionar, o sistema se comunica com terceiros escolhidos e contratados pelo operador:",
          )}
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>{t("a plataforma de mensagens usada para conversar com o cliente;")}</li>
          <li>
            {t(
              "o provedor de inteligência artificial contratado pelo operador, que recebe o trecho da conversa necessário para gerar a resposta ou avaliar a conversa;",
            )}
          </li>
          <li>
            {t(
              "quando o operador liga o Jev (desligado por padrão), a TypeSafe AI, nos Estados Unidos, que recebe cada mensagem do cliente, sozinha e já sem CPF, telefone e e-mail, para avaliar se ele está irritado, se a mensagem tenta manipular o atendimento automático, a qual área da empresa ela se destina, se ela pede para falar com uma pessoa ou para parar de receber mensagens e, quando ela responde a um follow-up, em qual das saídas do fluxo ela se encaixa;",
            )}
          </li>
          <li>
            {t(
              "quando o operador cadastra uma chave de Mapas (desligado por padrão), o Google, que recebe as coordenadas da localização que o cliente compartilhou, para devolver a rua e a cidade aproximadas;",
            )}
          </li>
          <li>{t("o provedor de infraestrutura onde o servidor está hospedado.")}</li>
        </ul>
        <p>{t("Os dados não são vendidos nem cedidos para publicidade de terceiros.")}</p>
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold">{t("5. Por quanto tempo")}</h2>
        <p>
          {t(
            "Conversas e registros de negócio são mantidos enquanto houver relação com o cliente ou obrigação legal de guarda. Arquivos de mídia têm prazo próprio, configurado pelo operador. Registros de auditoria são mantidos por período mais longo, por serem prova de quem fez o quê.",
          )}
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold">{t("6. Seus direitos")}</h2>
        <p>
          {t(
            "A LGPD garante a você confirmar se há tratamento, acessar seus dados, corrigir dados incompletos ou desatualizados, pedir anonimização ou eliminação, saber com quem foram compartilhados e revogar consentimento.",
          )}
        </p>
        <p>
          {t(
            "O sistema atende esses pedidos por um fluxo próprio: a exportação reúne o que existe sobre a pessoa, e a anonimização remove a identificação preservando o histórico de atendimento — por isso ela",
          )}{" "}
          <strong>{t("não pode ser desfeita")}</strong>.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold">{t("7. Segurança")}</h2>
        <p>
          {t(
            "O acesso é controlado por conta, senha e papel. A verificação em duas etapas é opcional para todos e só pode ser exigida de quem administra. Cada organização hospedada só enxerga os próprios dados, e as chaves de integração são guardadas cifradas.",
          )}
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold">{t("8. Encarregado e contato")}</h2>
        <p>
          {op.dpoEmail ? (
            <>
              {t("Para exercer seus direitos ou tirar dúvidas sobre privacidade, fale com o encarregado de dados:")}{" "}
              <a className="underline underline-offset-2" href={`mailto:${op.dpoEmail}`}>
                {op.dpoEmail}
              </a>
              .
            </>
          ) : (
            <>
              {t(
                "O operador ainda não publicou um endereço de contato do encarregado de dados nesta instalação. Os pedidos devem ser feitos pelos canais de atendimento da própria organização.",
              )}
            </>
          )}
        </p>
      </section>

      {/* A seção que o Google exige de todo app que pede acesso a dados de conta
          Google: o que é lido, para quê, que não se vende nem treina modelo, o
          selo de Uso Limitado e como desfazer. Cada frase aqui descreve o que o
          código faz (escopos em `lib/agenda/google/oauth.ts` e
          `lib/plataformas-de-anuncio/google/oauth.ts`) — acrescentar acesso novo
          ao Google sem acrescentar a frase correspondente é descumprir a política
          de dados de usuário do Google. */}
      <section className="space-y-2" id="dados-do-google">
        <h2 className="text-base font-semibold">{t("9. Dados do Google (Agenda e Google Ads)")}</h2>
        <p>
          {t(
            "Quando uma pessoa autorizada da organização conecta uma conta Google a este sistema, os dados recebidos do Google são usados somente para a função que ela pediu:",
          )}
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong>{t("Google Agenda:")}</strong>{" "}
            {t(
              "mostrar a ocupação da agenda, criar, alterar e cancelar os agendamentos feitos pelo próprio usuário e evitar choque de horários. O sistema guarda no servidor do operador o título e o horário dos eventos para calcular a ocupação, e o cálculo de horários livres usa apenas o início, o fim e a situação deles. O sistema não lê e-mails.",
            )}
          </li>
          <li>
            <strong>{t("Google Ads:")}</strong>{" "}
            {t(
              "enviar ao Google Ads as vendas que um anúncio trouxe, para que ele aprenda com elas, criar e listar ações de conversão e ler as métricas das campanhas da própria conta de anúncios.",
            )}
          </li>
        </ul>
        <p>
          {t(
            "Os dados do Google ficam no servidor do operador, não são vendidos, não são usados para publicidade e não são usados para treinar modelos de inteligência artificial. O uso e a transferência das informações recebidas das APIs do Google seguem a Política de Dados de Usuário dos Serviços de API do Google, incluindo os requisitos de Uso Limitado.",
          )}
        </p>
        <p>
          {t(
            "A conexão com a Agenda pode ser desfeita a qualquer momento em Agenda → Desconectar, e a do Google Ads é retirada pelo operador, a pedido. Em qualquer caso, a pessoa também pode revogar o acesso diretamente em",
          )}{" "}
          <a
            className="underline underline-offset-2"
            href="https://myaccount.google.com/permissions"
            target="_blank"
            rel="noreferrer"
          >
            myaccount.google.com/permissions
          </a>
          .
        </p>
      </section>
    </>
  );
}
