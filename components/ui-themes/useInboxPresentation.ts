"use client";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import type { LargurasDoInbox, StorageLeve } from "@/lib/inbox/larguras-do-inbox";
import {
  inboxPreferenceKey,
  readInboxPanel,
  resolveAdaptiveInbox,
  scopedInboxStorage,
  writeInboxPanel,
  type InboxPanelPreference,
  type InboxPresentation,
} from "@/lib/ui-themes/inbox-presentation";

const sessionPreferences = new Map<string, InboxPanelPreference>();
const listeners = new Map<string, Set<() => void>>();
const encode = (value: InboxPanelPreference) => `${value.pinned ? 1 : 0}${value.collapsed ? 1 : 0}`;

function browserStorage(): StorageLeve | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}
/** Presentation state only. Organization data, authorization and commands stay in the native host. */
export function useInboxPresentation(
  config: InboxPresentation,
  orgId: string | null,
  userId: string | null,
  root: RefObject<HTMLDivElement | null>,
  sizes: LargurasDoInbox,
  onInlineContact?: () => void,
) {
  const enabled = config.contactMode === "adaptive";
  const scope = JSON.stringify([enabled, orgId, userId]);
  const initialPinned = config.initialContactPinned ?? false;
  const storage = useMemo(
    () => (enabled ? scopedInboxStorage(browserStorage(), orgId, userId) : null),
    [enabled, orgId, userId],
  );
  const subscribe = useCallback(
    (listener: () => void) => {
      const scopedListeners = listeners.get(scope) ?? new Set<() => void>();
      listeners.set(scope, scopedListeners);
      scopedListeners.add(listener);
      const changed = (event: StorageEvent) => {
        if (event.key !== null && event.key !== inboxPreferenceKey(orgId, userId, "panel")) return;
        sessionPreferences.delete(scope);
        scopedListeners.forEach((notify) => notify());
      };
      window.addEventListener("storage", changed);
      return () => {
        scopedListeners.delete(listener);
        if (scopedListeners.size === 0) listeners.delete(scope);
        window.removeEventListener("storage", changed);
      };
    },
    [scope, orgId, userId],
  );
  const getSnapshot = useCallback(
    () => encode(sessionPreferences.get(scope) ?? readInboxPanel(storage, initialPinned)),
    [scope, storage, initialPinned],
  );
  const getServerSnapshot = useCallback(
    () => encode({ pinned: initialPinned, collapsed: false }),
    [initialPinned],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const pinned = snapshot[0] === "1";
  const collapsed = snapshot[1] === "1";
  const preference = { pinned, collapsed };
  const [width, setWidth] = useState(0);
  const { lista, ficha } = sizes;
  const minimumConversationWidth = config.minimumConversationWidth;
  useEffect(() => {
    if (!enabled) return;
    const element = root.current;
    if (!element) return;
    const measure = () => {
      const usefulWidth = element.clientWidth;
      setWidth(usefulWidth);
      if (
        resolveAdaptiveInbox(
          usefulWidth,
          { pinned, collapsed },
          { minimumConversationWidth },
          { lista, ficha },
        ).inlineContact
      ) {
        onInlineContact?.();
      }
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [
    enabled,
    root,
    scope,
    pinned,
    collapsed,
    lista,
    ficha,
    minimumConversationWidth,
    onInlineContact,
  ]);
  const update = useCallback(
    (next: InboxPanelPreference) => {
      if (!enabled || !orgId || !userId) return;
      sessionPreferences.set(scope, next);
      writeInboxPanel(storage, next);
      listeners.get(scope)?.forEach((notify) => notify());
    },
    [enabled, orgId, userId, scope, storage],
  );
  const setPinned = useCallback(
    (value: boolean) => update({ pinned: value, collapsed }),
    [update, collapsed],
  );
  const toggleCollapsed = useCallback(
    () => update({ pinned, collapsed: !collapsed }),
    [update, pinned, collapsed],
  );
  return {
    enabled,
    storage,
    preference,
    width,
    layout: resolveAdaptiveInbox(width, preference, config, sizes),
    setPinned,
    toggleCollapsed,
  };
}
