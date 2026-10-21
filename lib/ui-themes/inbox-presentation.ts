import { z } from "zod";
import type { StorageLeve, LargurasDoInbox } from "@/lib/inbox/larguras-do-inbox";
import { CONVERSA_MINIMA, limitarFicha, limitarLista } from "@/lib/inbox/larguras-do-inbox";

/** Presentation inputs owned by the host; package data cannot change queries or authority. */
export const inboxPresentationSchema = z
  .object({
    initialFilter: z.enum(["unassigned", "mine", "all", "closed", "archived", "ai"]).optional(),
    allTabFirst: z.boolean().optional(),
    selectionControl: z.enum(["persistent", "toggle"]).optional(),
    contactMode: z.enum(["native", "adaptive"]).optional(),
    initialContactPinned: z.boolean().optional(),
    listWidth: z.number().int().min(240).max(520).optional(),
    detailWidth: z.number().int().min(240).max(560).optional(),
    minimumDetailWidth: z.number().int().min(240).max(560).optional(),
    minimumConversationWidth: z.number().int().min(360).max(900).optional(),
  })
  .strict();
export type InboxPresentation = z.infer<typeof inboxPresentationSchema>;
export const inboxFiltersPresentationSchema = z
  .object({
    viewControl: z.enum(["tabs", "select"]).optional(),
    advancedControl: z.enum(["inline", "panel"]).optional(),
  })
  .strict();
export interface InboxPanelPreference {
  pinned: boolean;
  collapsed: boolean;
}

/** A blocked store never falls back to another user's or organization's key. */
export function inboxPreferenceKey(
  org: string | null,
  user: string | null,
  key: string,
): string | null {
  if (!org || !user) return null;
  return `deskcomm:ui-preference:${encodeURIComponent(org)}:${encodeURIComponent(user)}:inbox:${key}`;
}
export function scopedInboxStorage(
  storage: StorageLeve | null,
  org: string | null,
  user: string | null,
): StorageLeve | null {
  if (!storage || !org || !user) return null;
  return {
    getItem: (key) => storage.getItem(inboxPreferenceKey(org, user, key)!),
    setItem: (key, value) => storage.setItem(inboxPreferenceKey(org, user, key)!, value),
    removeItem: (key) => storage.removeItem(inboxPreferenceKey(org, user, key)!),
  };
}
const panelSchema = z.object({ pinned: z.boolean(), collapsed: z.boolean() }).strict();
export function readInboxPanel(
  storage: StorageLeve | null,
  initialPinned: boolean,
): InboxPanelPreference {
  const fallback = { pinned: initialPinned, collapsed: false };
  try {
    const raw = storage?.getItem("panel");
    if (!raw) return fallback;
    const parsed = panelSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : fallback;
  } catch {
    return fallback;
  }
}
export function writeInboxPanel(
  storage: StorageLeve | null,
  preference: InboxPanelPreference,
): void {
  try {
    storage?.setItem("panel", JSON.stringify(preference));
  } catch {
    /* Session remains usable. */
  }
}

/** Actual useful width decides whether the contact can coexist with a readable conversation. */
export function resolveAdaptiveInbox(
  width: number,
  preference: InboxPanelPreference,
  config: InboxPresentation,
  sizes: LargurasDoInbox,
) {
  const list = limitarLista(sizes.lista);
  const detail = limitarFicha(sizes.ficha, config.minimumDetailWidth);
  const minimum = config.minimumConversationWidth ?? CONVERSA_MINIMA;
  const measured = Number.isFinite(width) && width > 0;
  const mobile = !measured || width < list + minimum;
  const contactWidth = preference.collapsed ? 44 : detail;
  const inlineContact = !mobile && preference.pinned && width >= list + minimum + contactWidth;
  return {
    mobile,
    inlineContact,
    listWidth: list,
    detailWidth: detail,
    gridTemplateColumns: mobile
      ? "minmax(0,1fr)"
      : `${list}px minmax(0,1fr)${inlineContact ? ` ${contactWidth}px` : ""}`,
  };
}
