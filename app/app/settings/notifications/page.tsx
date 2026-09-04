import { requireAuth } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { Card } from "@/components/ui/card";
import { vapidPronto } from "@/lib/notifications/vapid";
import { NotificationPrefsClient } from "./_client";

export const dynamic = "force-dynamic";

/**
 * A TELA PRECISA SABER O QUE ESTA INSTALAÇÃO CONSEGUE FAZER.
 *
 * O backend sempre soube: `GET /api/v1/notifications/push` devolve
 * `enabled: false` sem o par VAPID, e o `PUT` recusa com 503 «Web Push não
 * configurado nesta instalação». Quem não perguntava era esta página.
 *
 * O efeito, num primeiro deploy — que é o estado em que NENHUMA instalação tem
 * as chaves —, era o pior tipo de silêncio:
 *
 *  1. a página afirmava «Push (Chrome) já funcionam» de forma incondicional;
 *  2. a pessoa ligava o interruptor de Push e o navegador pedia permissão —
 *     um incômodo real, cobrado do usuário;
 *  3. ela concedia, e `syncPushSubscription()` fazia `return` em silêncio
 *     (`if (!cfg?.data?.enabled || !publicKey) return`);
 *  4. o interruptor ficava ligado, sem nada avisando que a metade que ela
 *     queria — ser avisada com a aba FECHADA — não ia acontecer.
 *
 * E não havia, em lugar nenhum do produto, como descobrir que faltavam duas
 * variáveis no `.env`. Informação que existe no servidor e não chega a quem
 * decide é o mesmo que informação ausente.
 *
 * ⚠️ O INTERRUPTOR CONTINUA LIGÁVEL DE PROPÓSITO, e isto não é descuido: sem
 * VAPID o aviso na bandeja AINDA funciona enquanto a aba está aberta — é
 * `new Notification()` em `lib/notifications/emit.ts`, que não depende de
 * inscrição nenhuma. Desabilitar o controle tiraria capacidade que a
 * instalação tem. O que faltava era dizer a verdade sobre a metade que ela
 * não tem, e como consegui-la.
 *
 * Server component de propósito: `vapidPronto()` é lido no servidor, então a
 * primeira pintura já sai correta — sem fetch, sem estado intermediário em que
 * a tela promete o que não cumpre.
 */
export default async function NotificationsPage() {
  const user = await requireAuth();
  // `t` local em vez do hook: esta página é componente de SERVIDOR, e lá o
  // idioma vem resolvido em `user.idioma` (a cadeia pessoa → organização →
  // padrão vive em `lib/auth/server.ts`), sem reler o `locale` cru.
  const idioma = user.idioma;
  const t = (texto: string) => traduzir(texto, idioma);
  const pushPronto = vapidPronto();

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Notificações")}</h1>
        <p className="text-sm text-muted-foreground">{t("Canais e categorias.")}</p>
      </header>

      {pushPronto ? (
        <Card
          data-testid="push-status-pronto"
          className="border-amber-500/40 bg-amber-50/40 p-4 text-sm dark:bg-amber-900/10"
        >
          {t(
            "Email ainda não está disponível. In-app (toast) e Push (Chrome) já funcionam para as cinco categorias, inclusive com a aba fechada.",
          )}
        </Card>
      ) : (
        <Card
          data-testid="push-status-faltando-chaves"
          className="border-amber-500/40 bg-amber-50/40 p-4 text-sm dark:bg-amber-900/10"
        >
          <p className="font-medium">
            {t("Nesta instalação, os avisos só aparecem com o site aberto.")}
          </p>
          <p className="mt-2 text-muted-foreground">
            {/* ⚠️ Sem o nome do produto aqui, e não por estilo: a instalação é
                white-label e `tests/unit/branding.test.ts` varre `app/` atrás de
                marca escrita à mão. «o site» diz a mesma coisa e serve a quem
                revende o sistema com a marca dele. */}
            {t(
              "Ligar o Push abaixo já faz o aviso aparecer na bandeja do sistema enquanto você está com o site aberto numa aba. Para receber também com a aba fechada, quem administra o servidor precisa gerar um par de chaves uma única vez e reiniciar:",
            )}
          </p>
          <pre className="mt-2 overflow-x-auto rounded-md bg-muted p-2 text-xs">
            <code>npx web-push generate-vapid-keys</code>
          </pre>
          <p className="mt-2 text-muted-foreground">
            {t("O resultado vai no arquivo")} <code>.env</code>, {t("em")}{" "}
            <code>VAPID_PUBLIC_KEY</code> {t("e")} <code>VAPID_PRIVATE_KEY</code>.{" "}
            {t("Email ainda não está disponível.")}
          </p>
        </Card>
      )}

      <NotificationPrefsClient />
    </div>
  );
}
