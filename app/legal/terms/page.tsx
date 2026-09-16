import type { Metadata } from "next";

import { nomeDoOperador, resolverOperador } from "@/lib/legal/operador";
import { createClient } from "@/lib/supabase/server";
import { normalizarIdioma } from "@/lib/i18n/idiomas";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Termos de Uso" };

export default async function TermsPage() {
  const op = await resolverOperador();
  const operador = nomeDoOperador(op);

  // Rota fora da árvore de `app/app/layout.tsx` — sem `IdiomaProvider`, então
  // resolve o idioma direto, como `admin/forbidden/page.tsx`. Página legal
  // pública: pode ser lida sem sessão, por isso `user` é opcional.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const idioma = normalizarIdioma(
    (user?.user_metadata?.locale as string | undefined) ?? null,
  );
  const t = (texto: string) => traduzir(texto, idioma);

  return (
    <>
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t("Termos de Uso")}</h1>
        <p className="text-muted-foreground">
          {t("As regras de uso desta instalação do")} {op.sistema}.
        </p>
      </header>

      <section className="space-y-2">
        <h2 className="text-base font-semibold">{t("1. Quem é quem")}</h2>
        <p>
          {t("O")} {op.sistema} {t("é um software de código aberto instalado e operado por")}{" "}
          <strong>{operador}</strong>
          {op.cnpj ? ` (CNPJ ${op.cnpj})` : ""}, {t("daqui em diante")}{" "}
          <strong>{t("o operador")}</strong>.{" "}
          {t(
            "É o operador quem mantém este servidor, decide como o sistema é usado e responde pelos dados tratados aqui.",
          )}
        </p>
        <p>
          {t(
            "Os autores e mantenedores do software não operam esta instalação, não têm acesso a este servidor nem aos dados nele guardados, e não são parte da relação entre o operador e você. Qualquer pedido sobre uso, cobrança, suporte ou dados deve ser dirigido ao operador.",
          )}
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold">{t("2. O que o sistema faz")}</h2>
        <p>
          {t("O")} {op.sistema}{" "}
          {t(
            "organiza atendimento e vendas: recebe e envia mensagens pelos canais que o operador conectar, registra contatos e negócios, e permite que agentes de inteligência artificial atendam junto com pessoas, sob as regras que o operador configurar.",
          )}
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold">{t("3. Sua conta")}</h2>
        <p>
          {t(
            "O acesso é pessoal. Você é responsável por manter sua senha em segredo e pelo que for feito com a sua conta. Contas de administrador exigem verificação em duas etapas. Avise o operador imediatamente se suspeitar de acesso indevido.",
          )}
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold">{t("4. Uso aceitável")}</h2>
        <p>{t("Ao usar este sistema, você concorda em não:")}</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>{t("enviar mensagens não solicitadas em massa, nem burlar pedidos de descadastro;")}</li>
          <li>{t("usar os dados de clientes para finalidade diferente da que os originou;")}</li>
          <li>{t("tentar acessar dados de outra organização hospedada nesta instalação;")}</li>
          <li>
            {t("violar os termos dos serviços conectados, como as regras da plataforma de mensagens.")}
          </li>
        </ul>
        <p>
          {t(
            "O sistema respeita pedidos de parada enviados pelos clientes: quem pedir para não receber mais mensagens é bloqueado automaticamente para envios.",
          )}
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold">{t("5. Conteúdo e dados")}</h2>
        <p>
          {t(
            "Os dados inseridos aqui — contatos, conversas, negócios, arquivos — pertencem ao operador e às pessoas a que se referem. O tratamento desses dados é descrito na",
          )}{" "}
          <a className="underline underline-offset-2" href="/legal/privacy">
            {t("Política de Privacidade")}
          </a>
          .
        </p>
        <p>
          {t(
            "Respostas geradas por inteligência artificial podem conter erros. Elas não substituem conferência humana em decisões que envolvam preço, prazo, saúde, crédito ou obrigação legal.",
          )}
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold">{t("6. Disponibilidade e garantias")}</h2>
        <p>
          {t(
            "Este sistema roda em servidor do operador e depende de serviços de terceiros para funcionar. O software é distribuído “como está”, sem garantia de funcionamento ininterrupto ou de adequação a uma finalidade específica. Interrupções, falhas de terceiros e perda de dados por causas fora do controle do operador não geram obrigação de indenizar, salvo quando a lei determinar.",
          )}
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold">{t("7. Encerramento")}</h2>
        <p>
          {t(
            "O operador pode suspender ou encerrar o seu acesso em caso de descumprimento destes termos. Você pode pedir o encerramento da sua conta a qualquer momento. O encerramento do acesso não apaga automaticamente os registros de atendimento, que seguem as regras de retenção descritas na Política de Privacidade.",
          )}
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold">{t("8. Mudanças")}</h2>
        <p>
          {t(
            "O operador pode atualizar estes termos. Mudanças relevantes devem ser comunicadas antes de passarem a valer.",
          )}
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold">{t("9. Contato")}</h2>
        <p>
          {t("Falar com o operador")}
          {op.dpoEmail ? (
            <>
              :{" "}
              <a className="underline underline-offset-2" href={`mailto:${op.dpoEmail}`}>
                {op.dpoEmail}
              </a>
            </>
          ) : (
            ` ${t("pelos canais de atendimento da própria organização")}`
          )}
          .
        </p>
      </section>
    </>
  );
}
