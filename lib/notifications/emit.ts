import { NOTIFY_KINDS, type NotifyKind } from "./kinds";
import { areAlertsEnabled, getPermission } from "./permission";
import { ensureNotifyServiceWorker } from "./service_worker";
import { playSound, type SoundId } from "./sounds";

const BODY_MAX = 140;

export interface EmitNotificationInput {
  kind: NotifyKind;
  title: string;
  body: string;
  tag?: string;
  href?: string;
  icon?: string;
  sound?: SoundId;
  force?: boolean;
}

export function truncateNotifyBody(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  if (t.length <= BODY_MAX) return t;
  return `${t.slice(0, BODY_MAX - 1)}…`;
}

function absUrl(path: string): string {
  if (!path) return "";
  try {
    return new URL(path, window.location.origin).href;
  } catch {
    return path;
  }
}

/**
 * Com o service worker controlando a página, o aviso sai pelo registro dele —
 * o MESMO que mostra o push. Só aí a mesma tag substitui de um lado para o
 * outro: no Chrome do computador, `new Notification` e o aviso do SW vivem em
 * listas separadas, e o mesmo aviso apareceria duas vezes.
 *
 * Sem SW no controle, `new Notification()`; `silent: false` usa o som do SO
 * (AudioContext some com a aba oculta). Se o construtor falha (Android), cai
 * no `showNotification` do service worker.
 */
export function emitNotification(input: EmitNotificationInput): void {
  if (typeof window === "undefined") return;
  const perm = getPermission();
  const enabled = areAlertsEnabled();
  if (!input.force && !enabled) return;
  if (perm !== "granted") return;

  const spec = NOTIFY_KINDS[input.kind];
  const sound = input.sound ?? spec.sound;
  const body = truncateNotifyBody(input.body);
  const tag = input.tag ? `${spec.tagPrefix}:${input.tag}` : `${spec.tagPrefix}:${Date.now()}`;
  const marca = absUrl("/icon");
  const icon = absUrl(input.icon || marca);
  const href = input.href ? absUrl(input.href) : "";
  const opts: NotificationOptions & { renotify?: boolean } = {
    body,
    tag,
    silent: false,
    renotify: true,
    icon,
    data: { href },
  };

  if (typeof document !== "undefined" && document.visibilityState === "visible") {
    try {
      playSound(sound, 1.0);
    } catch {
      // AudioContext recusa
    }
  }

  const sw = typeof navigator !== "undefined" ? navigator.serviceWorker : undefined;
  if (sw?.controller) {
    void sw.ready
      .then((reg) => reg.showNotification(input.title, opts))
      .catch(() => mostrarPeloConstrutor(input.title, opts, href));
    return;
  }
  mostrarPeloConstrutor(input.title, opts, href);
}

function mostrarPeloConstrutor(title: string, opts: NotificationOptions, href: string): void {
  try {
    const n = new Notification(title, opts);
    n.onclick = () => {
      window.focus();
      if (href) window.location.assign(href);
      n.close();
    };
  } catch {
    void showInOsTray(title, opts);
  }
}

async function showInOsTray(title: string, opts: NotificationOptions): Promise<void> {
  const reg = await ensureNotifyServiceWorker();
  const ready =
    typeof navigator !== "undefined" && navigator.serviceWorker
      ? await navigator.serviceWorker.ready.catch(() => null)
      : null;
  const alvo = ready ?? reg;
  if (!alvo) return;
  try {
    await alvo.showNotification(title, opts);
  } catch {
    // SW indisponível
  }
}
