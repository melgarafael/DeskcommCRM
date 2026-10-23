import { areAlertsEnabled, getPermission } from "./permission";
import { canalLigado } from "./prefs";
import { ensureNotifyServiceWorker } from "./service_worker";

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function mesmosBytes(a: ArrayBuffer, b: Uint8Array): boolean {
  if (a.byteLength !== b.length) return false;
  const x = new Uint8Array(a);
  return x.every((v, i) => v === b[i]);
}

/**
 * O QUE A INSCRIÇÃO DESTE APARELHO DEU (issue #3116).
 *
 * `syncPushSubscription` devolvia `void` e não olhava a resposta do PUT: a
 * recusa 422 da rota (`app/api/v1/notifications/push/route.ts:60`, o serviço de
 * push fora da lista de `servicos-de-push.ts`) era invisível. A tela ligava o
 * interruptor e nenhum aviso chegava — o pior silêncio, porque a pessoa acha
 * que está inscrita. Agora a função devolve o que aconteceu para quem a chama
 * poder desfazer o interruptor e dizer o porquê.
 *
 * - `ativo`    — o PUT foi aceito (2xx); a inscrição está de pé, como sempre.
 * - `recusado` — o servidor recusou (`!res.ok`): NÃO está inscrito, e `motivo`
 *                carrega a frase do servidor quando veio.
 * - `sem_rede` — o PUT nem chegou ao servidor (o `fetch` lançou): também NÃO
 *                está inscrito, mas dizer "o servidor recusou" a quem está sem
 *                internet daria a causa errada — por isso é outro estado.
 * - `ignorado` — o caminho nem chegou ao servidor: os mesmos `return` de antes,
 *                sem recusa a reportar. ⚠️ Mas ali cabiam CAUSAS DIFERENTES
 *                atrás do mesmo rótulo (issue #3164), e por isso o `motivo`
 *                diz QUAL caminho de retorno foi — quem chama decide pela
 *                causa, não pelo nome do estado.
 */
export type SituacaoDaInscricao = "ativo" | "recusado" | "sem_rede" | "ignorado";

/**
 * OS CAMINHOS DE RETORNO EM QUE NADA FOI INSCRITO (issue #3164).
 *
 * Eram todos `ignorado`, sem mais nada, e a tela não dizia qual deles foi.
 * Cada um destes quatro diz que ESTE APARELHO ou ESTA INSTALAÇÃO não recebe
 * aviso com o site FECHADO — mas só uma parte deles desliga o interruptor: ver
 * `MOTIVOS_QUE_DESLIGAM`.
 */
export const MOTIVOS_DO_APARELHO = [
  "sem_service_worker",
  "sem_vapid",
  "inscricao_incompleta",
  "navegador_recusou",
] as const;

/**
 * QUAIS CAUSAS DE APARELHO DESLIGAM O INTERRUPTOR (#3157, corrigindo a #3164).
 *
 * O interruptor de Push de mensagem governa DUAS entregas: o aviso com o site
 * fechado (Web Push: VAPID + inscrição) e o aviso na bandeja com a aba aberta
 * (`lib/notifications/emit.ts`, pelo service worker ou por `new Notification()`,
 * liberado por `canalLigado("message", "push")` em `deliver.ts`). Desligá-lo
 * mata as duas.
 *
 * - `sem_vapid` NÃO desliga: sem o par de chaves o aviso com a aba aberta
 *   continua funcionando, e a página já diz isso e como conseguir as chaves
 *   (decisão registrada em `app/app/settings/notifications/page.tsx`, no
 *   comentário "O INTERRUPTOR CONTINUA LIGÁVEL DE PROPÓSITO").
 * - `sem_service_worker` NÃO desliga: nos navegadores de computador o aviso com
 *   a aba aberta cai em `new Notification()`. No Chrome do celular esse caminho
 *   não existe sem service worker — isso ainda não foi medido, e por isso a
 *   frase da tela só fala do site fechado.
 * - `inscricao_incompleta` e `navegador_recusou` desligam, como `recusado` e
 *   `sem_rede`: a pessoa pediu a inscrição deste aparelho e ela não aconteceu.
 */
export const MOTIVOS_QUE_DESLIGAM = ["inscricao_incompleta", "navegador_recusou"] as const;

export type MotivoDoAparelho = (typeof MOTIVOS_DO_APARELHO)[number];

export type MotivoDoIgnorado =
  /** A função rodou fora do navegador (SSR): não há inscrição a fazer. */
  | "fora_do_navegador"
  /**
   * Escolha da PESSOA: permissão não concedida, alertas desligados ou o canal
   * de push desligado. Aqui o interruptor está dizendo uma preferência dela, e
   * desligá-lo sozinho seria tirar a escolha da pessoa — a tela NÃO desliga.
   */
  | "preferencia_do_usuario"
  | MotivoDoAparelho;

/**
 * `MotivoDoIgnorado` é o rótulo; este é o teste. Existe para quem chama poder
 * estreitar o tipo (e a frase que a tela mostra) sem reescrever a lista.
 */
export function ehMotivoDoAparelho(motivo: MotivoDoIgnorado): motivo is MotivoDoAparelho {
  return (MOTIVOS_DO_APARELHO as readonly string[]).includes(motivo);
}

export type ResultadoDaInscricao =
  | { situacao: "ativo"; motivo: "" }
  | { situacao: "sem_rede"; motivo: "" }
  /** Frase da recusa (`error.message` da rota), quando o servidor mandou uma. */
  | { situacao: "recusado"; motivo: string }
  | { situacao: "ignorado"; motivo: MotivoDoIgnorado };

function ignorado(motivo: MotivoDoIgnorado): ResultadoDaInscricao {
  return { situacao: "ignorado", motivo };
}

/**
 * O INTERRUPTOR TEM DE VOLTAR A DESLIGAR? (issues #3116 e #3164)
 *
 * `ativo` devolve `false` e `recusado`/`sem_rede` devolvem `true` (o servidor
 * não gravou a inscrição, é o que a #3116 já mede). Para `ignorado` quem
 * responde é o MOTIVO, e só os de `MOTIVOS_QUE_DESLIGAM` desligam — a falta de
 * VAPID ou de service worker não, porque o aviso com a aba aberta não depende
 * deles (ver o comentário da lista). Preferência do usuário e "fora do
 * navegador" também não.
 *
 * Aceita `undefined`/`null` para quem dubla a função sem devolver nada: ali não
 * há notícia nenhuma, e sem notícia não se mexe no interruptor.
 */
export function pushNaoEntrega(resultado: ResultadoDaInscricao | undefined | null): boolean {
  if (!resultado) return false;
  if (resultado.situacao === "ativo") return false;
  if (resultado.situacao === "ignorado")
    return (MOTIVOS_QUE_DESLIGAM as readonly string[]).includes(resultado.motivo);
  return true;
}

/**
 * A frase que a rota JÁ devolve na recusa — `fail(...)` responde
 * `{ error: { code, message } }` (`lib/api/wrappers.ts`). Não inventa contrato
 * novo: lê o corpo e devolve "" quando não é JSON ou não traz mensagem.
 */
async function motivoDaRecusa(res: Response): Promise<string> {
  try {
    const corpo = (await res.json()) as { error?: { message?: unknown } };
    const mensagem = corpo?.error?.message;
    return typeof mensagem === "string" ? mensagem : "";
  } catch {
    return "";
  }
}

/**
 * Liga a inscrição Web Push depois da permissão. Sem VAPID no servidor, no-op.
 *
 * ⚠️ QUEM MAIS CHAMA — e por que eles ignoram o resultado: o interruptor da tela
 * (`app/app/settings/notifications/_client.tsx`) é o único que mostra a recusa.
 * `hooks/notifications/useNotificationPermission.ts` (ao conceder a permissão) e
 * `hooks/notifications/useInboundMessageAlerts.ts` (ao abrir o app) re-sincronizam
 * em segundo plano e seguem com `void`: não há interruptor para desfazer nem
 * recusa para mostrar naquele instante — a tela de Notificações é quem responde
 * por isso. Mudar a assinatura aqui não os quebra: eles descartam o retorno.
 */
export async function syncPushSubscription(): Promise<ResultadoDaInscricao> {
  if (typeof window === "undefined") return ignorado("fora_do_navegador");
  // A preferência é a fonte: `alerts.enabled` é espelho que `request()` regrava.
  if (getPermission() !== "granted" || !areAlertsEnabled() || !canalLigado("message", "push"))
    return ignorado("preferencia_do_usuario");
  const reg = await ensureNotifyServiceWorker();
  if (!reg?.pushManager) return ignorado("sem_service_worker");

  let cfg: { data?: { enabled?: boolean; public_key?: string } } | null;
  try {
    cfg = (await fetch("/api/v1/notifications/push").then((r) => r.json())) as typeof cfg;
  } catch {
    // Não deu para LER a configuração: o `fetch` não chegou ao servidor ou a
    // resposta não era JSON (sessão caída, por exemplo). Dizer "a instalação
    // não tem o par de chaves" aqui seria chutar a causa — é o mesmo caso do
    // PUT logo abaixo, e a tela já sabe dizer este.
    return { situacao: "sem_rede", motivo: "" };
  }
  const publicKey = cfg?.data?.public_key;
  if (!cfg?.data?.enabled || !publicKey) return ignorado("sem_vapid");

  const chave = urlBase64ToUint8Array(publicKey);
  let sub = await reg.pushManager.getSubscription();
  // Inscrição feita com OUTRA chave (o par do servidor mudou, por exemplo num
  // backup restaurado sem o .env) nunca mais recebe nada, e o navegador não
  // avisa: refaz com a chave atual. O PUT abaixo grava a nova. Navegador que
  // não informa a chave da inscrição fica como está: refazer a cada abertura
  // criaria uma inscrição nova toda vez.
  const chaveDaInscricao = sub?.options.applicationServerKey;
  if (sub && chaveDaInscricao && !mesmosBytes(chaveDaInscricao, chave)) {
    await sub.unsubscribe();
    sub = null;
  }
  if (!sub) {
    try {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: chave as BufferSource,
      });
    } catch {
      // O navegador recusou CRIAR a inscrição (permissão revogada no meio do
      // caminho, Push desligado no sistema, modo privado): é limite do
      // aparelho, não escolha da pessoa nem recusa do servidor. Sem este
      // `catch` a promessa rejeitava e o interruptor ficava ligado em silêncio,
      // que é exatamente a classe da #3116.
      return ignorado("navegador_recusou");
    }
  }

  const json = sub.toJSON();
  // Inscrição sem endpoint ou sem as duas chaves é inscrição que nenhum serviço
  // de push aceita: o PUT recusaria, e o interruptor ficaria mentindo.
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth)
    return ignorado("inscricao_incompleta");

  let res: Response;
  try {
    res = await fetch("/api/v1/notifications/push", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        endpoint: json.endpoint,
        keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
      }),
    });
  } catch {
    // Sem rede o PUT não chegou: o servidor não tem esta inscrição, e o
    // interruptor ligado seria mentira. Não é recusa: o servidor nem respondeu.
    return { situacao: "sem_rede", motivo: "" };
  }
  if (!res.ok) return { situacao: "recusado", motivo: await motivoDaRecusa(res) };
  return { situacao: "ativo", motivo: "" };
}

/**
 * Encerra o push DESTE aparelho: o servidor esquece a inscrição e o navegador
 * cancela a dele. Chamado ao desligar os alertas de mensagem e ao sair — antes
 * da action de saída, porque o DELETE precisa do cookie que ela apaga.
 *
 * Nunca lança, e as duas etapas são independentes: a saída não pode depender
 * da rede, e o cancelamento sozinho já faz o próximo envio limpar a linha no
 * servidor (404/410). Não registra service worker: sair não deve instalar nada.
 */
export async function encerrarPushDesteAparelho(): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.serviceWorker) return;
  let sub: PushSubscription | null = null;
  try {
    const reg = await navigator.serviceWorker.getRegistration("/");
    sub = (await reg?.pushManager?.getSubscription()) ?? null;
  } catch {
    return; // service worker inacessível: não há inscrição a encerrar
  }
  if (!sub) return;
  try {
    await fetch("/api/v1/notifications/push", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: sub.endpoint }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // sem rede: o cancelamento abaixo basta para a faxina do próximo envio
  }
  try {
    await sub.unsubscribe();
  } catch {
    // inscrição já inválida no navegador
  }
}
