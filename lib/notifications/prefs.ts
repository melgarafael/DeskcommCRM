import { setAlertsEnabled } from "./permission";

export const NOTIFY_UI_CATEGORIES = [
  "message",
  "lead_assigned",
  "lead_won",
  "lead_lost",
  "mention",
] as const;

export type NotifyCategory = (typeof NOTIFY_UI_CATEGORIES)[number];
export type NotifyChannelPref = "in_app" | "push";

export type NotifyPrefs = Record<NotifyCategory, Record<NotifyChannelPref, boolean>>;

const KEY = "notify.prefs.v1";

export function prefsPadrao(): NotifyPrefs {
  let pushMsg = true;
  if (typeof window !== "undefined") {
    try {
      if (window.localStorage.getItem("alerts.enabled") === "0") pushMsg = false;
    } catch {
      // ignore
    }
  }
  return {
    message: { in_app: true, push: pushMsg },
    lead_assigned: { in_app: true, push: true },
    lead_won: { in_app: true, push: true },
    lead_lost: { in_app: true, push: true },
    mention: { in_app: true, push: true },
  };
}

export function lerPrefs(): NotifyPrefs {
  const base = prefsPadrao();
  if (typeof window === "undefined") return base;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return base;
    const parsed = JSON.parse(raw) as Partial<NotifyPrefs>;
    for (const cat of NOTIFY_UI_CATEGORIES) {
      const row = parsed[cat];
      if (!row) continue;
      if (typeof row.in_app === "boolean") base[cat].in_app = row.in_app;
      if (typeof row.push === "boolean") base[cat].push = row.push;
    }
  } catch {
    // JSON inválido — volta ao padrão
  }
  return base;
}

/**
 * ═══ POR QUE ISTO É UM EXTERNAL STORE, E NÃO `useState` ═══
 *
 * `NotificationPrefsClient` inicializava com `useState(() => lerPrefs())`, e o
 * inicializador de `useState` roda de novo na HIDRATAÇÃO — que é a primeira
 * renderização do cliente, a mesma que o React compara contra o HTML que o
 * servidor mandou. `lerPrefs()`/`prefsPadrao()` decidem a fonte por
 * `typeof window === "undefined"`: no servidor sempre devolvem o padrão (tudo
 * ligado); no navegador leem `localStorage` de verdade. Quem desligou qualquer
 * aviso produzia, nesse instante, um cliente dizendo `push: false` contra um
 * servidor dizendo `push: true` — em dez `Switch` e no `data-testid` que
 * `canalLigado("message", "push")` alimentava durante o render.
 *
 * A saída é a mesma que `lib/theme.tsx` já usa para esta exata classe de
 * defeito (issue #666): `useSyncExternalStore`. `getServerSnapshot` devolve o
 * valor determinístico que o servidor viu, e a comparação de hidratação usa
 * esse mesmo valor dos DOIS lados; só depois do commit o React troca para
 * `getSnapshot`, o valor real — sem `setState` dentro de `useEffect` (que o
 * `react-hooks/set-state-in-effect` recusa, corretamente) e sem a cascata de
 * renders que ele causaria.
 */
type OuvinteDePrefs = () => void;
const ouvintesDePrefs = new Set<OuvinteDePrefs>();

export function assinarPrefs(ouvinte: OuvinteDePrefs): () => void {
  ouvintesDePrefs.add(ouvinte);
  return () => {
    ouvintesDePrefs.delete(ouvinte);
  };
}

// O cache não é otimização: `useSyncExternalStore` compara snapshots com
// `Object.is`, e `lerPrefs()` monta um objeto novo a cada chamada — devolvê-lo
// direto do `getSnapshot` seria um laço infinito de re-render.
let prefsEmCache: NotifyPrefs | null = null;

export function getPrefsSnapshot(): NotifyPrefs {
  if (prefsEmCache === null) prefsEmCache = lerPrefs();
  return prefsEmCache;
}

const PREFS_DO_SERVIDOR: NotifyPrefs = {
  message: { in_app: true, push: true },
  lead_assigned: { in_app: true, push: true },
  lead_won: { in_app: true, push: true },
  lead_lost: { in_app: true, push: true },
  mention: { in_app: true, push: true },
};

/**
 * Sem `window`, `prefsPadrao()` devolve exatamente este valor — congelado aqui.
 *
 * É uma DUPLICATA deliberada, e ela não pode ser derivada: chamar
 * `prefsPadrao()` no escopo do módulo leria o `localStorage` de verdade no
 * navegador, que é justamente o que este valor existe para não fazer.
 *
 * Duplicata sem vigia diverge. Quem acrescentar uma categoria a
 * `NOTIFY_UI_CATEGORIES`, ou mudar um padrão, muda `prefsPadrao()` e não muda
 * este objeto — e o desfecho é a volta silenciosa do defeito que o PR #695
 * consertou, ou pior: `getServerSnapshot` devolvendo um objeto sem a chave que
 * o componente vai ler. O vigia é
 * `tests/unit/prefs-do-servidor-nao-diverge-do-padrao.test.ts`.
 */
export function getPrefsSnapshotDoServidor(): NotifyPrefs {
  return PREFS_DO_SERVIDOR;
}

export function canalLigado(category: NotifyCategory, channel: NotifyChannelPref): boolean {
  return lerPrefs()[category][channel];
}

export function gravarCanal(
  category: NotifyCategory,
  channel: NotifyChannelPref,
  on: boolean,
): NotifyPrefs {
  const next = lerPrefs();
  next[category][channel] = on;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // ignore
    }
  }
  if (category === "message" && channel === "push") setAlertsEnabled(on);
  prefsEmCache = next;
  for (const ouvinte of ouvintesDePrefs) ouvinte();
  return next;
}
