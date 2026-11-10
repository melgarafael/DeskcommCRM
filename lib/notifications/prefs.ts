import { setAlertsEnabled } from "./permission";

export const NOTIFY_UI_CATEGORIES = [
  "message",
  "lead_assigned",
  "lead_won",
  "lead_lost",
  "mention",
  "call_inbound",
  // Os dois avisos da Central que vão ao celular e que a pessoa pode calar.
  // Sem saldo no provedor e proposta para revisar não entram: são raros e
  // travam a operação, e chegam sempre.
  "handoff",
  "stage_alert",
] as const;

/**
 * Tipos que só existem no CELULAR: o aviso dentro do app é o da Central, com
 * som próprio (`./sons-da-org.ts`), e a coluna In-app não os governa.
 */
export const SO_NO_CELULAR: ReadonlySet<NotifyCategory> = new Set<NotifyCategory>(["handoff", "stage_alert"]);

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
    call_inbound: { in_app: true, push: true },
    handoff: { in_app: true, push: true },
    stage_alert: { in_app: true, push: true },
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
  // Ligação chegando (módulo de telefonia, #677). Entra aqui porque
  // `NotifyPrefs` exige uma linha por tipo: sem ela o tipo não fecha, e o
  // servidor decidiria por ausência em vez de por declaração.
  call_inbound: { in_app: true, push: true },
  lead_assigned: { in_app: true, push: true },
  lead_won: { in_app: true, push: true },
  lead_lost: { in_app: true, push: true },
  mention: { in_app: true, push: true },
  handoff: { in_app: true, push: true },
  stage_alert: { in_app: true, push: true },
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
  return pushEfetivo(lerPrefs(), category, channel);
}

/**
 * Cada tipo liga e desliga o próprio Push. Até 09/11/2026 o de mensagem era o
 * interruptor do aparelho, porque o servidor não separava os tipos: quem só
 * queria "Lead atribuído a você" tinha de receber toda mensagem. Hoje o
 * servidor sabe quais tipos o aparelho calou (`tiposCalados`, gravados na
 * inscrição) e o aparelho só sai do push quando TODOS estão desligados.
 */
export function pushEfetivo(prefs: NotifyPrefs, category: NotifyCategory, channel: NotifyChannelPref): boolean {
  return prefs[category][channel];
}

/** Algum tipo ainda quer o celular? Nenhum → a inscrição do aparelho sai. */
export function algumPushLigado(prefs: NotifyPrefs): boolean {
  return NOTIFY_UI_CATEGORIES.some((cat) => prefs[cat].push);
}

/** Os tipos que este aparelho calou — o que vai para `push_subscriptions.tipos_calados`. */
export function tiposCalados(prefs: NotifyPrefs): NotifyCategory[] {
  return NOTIFY_UI_CATEGORIES.filter((cat) => !prefs[cat].push);
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
  // `alerts.enabled` (o ícone do topo) espelha "este aparelho recebe algum aviso".
  if (channel === "push") setAlertsEnabled(algumPushLigado(next));
  prefsEmCache = next;
  for (const ouvinte of ouvintesDePrefs) ouvinte();
  return next;
}
