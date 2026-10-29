"use client";
import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

interface ThreadPosition {
  conversationId: string | null;
  ready: boolean;
  itemCount: number;
  lastItemKey: string;
  lastMessageId: string;
  lastMessageIsOwn: boolean;
  pages: number;
  searching: boolean;
}

function viewportSize(scroller: HTMLDivElement) {
  return `${scroller.scrollHeight}:${scroller.clientHeight}:${scroller.clientWidth}`;
}

/** Follow the previous viewport intention, never a distance measured after a new bubble grew. */
export function useThreadAutoScroll(position: ThreadPosition) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const following = useRef(true);
  const scrollingToEnd = useRef(false);
  const anchored = useRef(false);
  const observedSize = useRef<string | null>(null);
  const previous = useRef<ThreadPosition | null>(null);
  const olderAnchor = useRef<{ top: number; height: number; pages: number } | null>(null);
  const [hasNewMessages, setHasNewMessages] = useState(false);

  const scrollToEnd = useCallback((behavior: ScrollBehavior = "smooth") => {
    if (!bottomRef.current || !scrollerRef.current) return;
    following.current = true;
    scrollingToEnd.current = true;
    setHasNewMessages(false);
    bottomRef.current.scrollIntoView({ behavior, block: "end" });
  }, []);

  const onScroll = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const nearEnd = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 120;
    if (nearEnd) {
      observedSize.current = viewportSize(scroller);
      following.current = true;
      scrollingToEnd.current = false;
      setHasNewMessages(false);
    } else if (!scrollingToEnd.current) {
      // Reflow can itself emit scroll before ResizeObserver (for example when
      // a mobile breakpoint wraps the bubbles). It is not a history gesture.
      const layoutChanged = observedSize.current !== null
        && observedSize.current !== viewportSize(scroller);
      if (!following.current || !layoutChanged) following.current = false;
    }
  }, []);

  // A smooth programmatic scroll can emit intermediate events far from the end.
  // Only an actual user scroll gesture cancels that destination.
  const interruptScroll = useCallback(() => {
    scrollingToEnd.current = false;
    const scroller = scrollerRef.current;
    if (scroller) observedSize.current = viewportSize(scroller);
    following.current = !!scroller
      && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 120;
  }, []);
  const onPointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const scroller = event.currentTarget;
    const x = event.clientX - scroller.getBoundingClientRect().left;
    if (event.target === scroller && (x >= scroller.clientWidth || x < scroller.clientLeft))
      interruptScroll(); // scrollbar drag, including an RTL scrollbar
  }, [interruptScroll]);
  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget
      && ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key))
      interruptScroll();
  }, [interruptScroll]);

  const beforeLoadOlder = useCallback(() => {
    const scroller = scrollerRef.current;
    if (scroller) olderAnchor.current = {
      top: scroller.scrollTop, height: scroller.scrollHeight, pages: previous.current?.pages ?? 0,
    };
    interruptScroll();
    following.current = false; // paging explicitly asks to keep the history anchor
  }, [interruptScroll]);

  const { conversationId, ready, itemCount, lastItemKey, lastMessageId, lastMessageIsOwn, pages, searching } = position;
  useLayoutEffect(() => {
    const old = previous.current;
    const changedConversation = old?.conversationId !== conversationId;
    if (changedConversation) {
      anchored.current = false;
      following.current = true;
      scrollingToEnd.current = false;
      olderAnchor.current = null;
      observedSize.current = null;
      setHasNewMessages(false);
    }
    const next = { conversationId, ready, itemCount, lastItemKey, lastMessageId, lastMessageIsOwn, pages, searching };
    previous.current = next;
    if (!ready) return; // a skeleton has no scroller; opening is still pending
    const newMessage = !changedConversation && !!lastMessageId && old?.lastMessageId !== lastMessageId;
    const older = !changedConversation && !!old?.pages && pages > old.pages;
    if (older) {
      const saved = olderAnchor.current, scroller = scrollerRef.current;
      if (saved && scroller && pages > saved.pages)
        scroller.scrollTop = saved.top + scroller.scrollHeight - saved.height;
      olderAnchor.current = null;
    }
    if (searching && !(newMessage && lastMessageIsOwn)) {
      interruptScroll();
      following.current = false;
      if (newMessage) setHasNewMessages(true);
      return;
    }
    if (older && !newMessage) return;
    const firstAnchor = !anchored.current;
    const changedContent = changedConversation || !old?.ready || itemCount !== old.itemCount
      || lastItemKey !== old.lastItemKey || newMessage;
    if (firstAnchor || (changedContent && (following.current || (newMessage && lastMessageIsOwn)))) {
      if (bottomRef.current) anchored.current = true;
      scrollToEnd(firstAnchor ? "auto" : "smooth");
    } else if (newMessage) {
      setHasNewMessages(true);
    }
  }, [conversationId, ready, itemCount, lastItemKey, lastMessageId, lastMessageIsOwn, pages, searching, interruptScroll, scrollToEnd]);

  // Images, cards and the mobile keyboard can change height without adding an item.
  // Keep the destination only while following; never pull a reader out of history.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current, content = contentRef.current;
    if (!ready || !scroller || !content || typeof ResizeObserver === "undefined") return;
    observedSize.current = viewportSize(scroller);
    const observer = new ResizeObserver(() => {
      observedSize.current = viewportSize(scroller);
      if (!following.current || previous.current?.searching) return;
      scroller.scrollTop = scroller.scrollHeight;
    });
    observer.observe(scroller);
    observer.observe(content);
    return () => observer.disconnect();
  }, [conversationId, ready]);

  return { scrollerRef, contentRef, bottomRef, hasNewMessages, scrollToEnd, beforeLoadOlder,
    onScroll, onWheel: interruptScroll, onTouchMove: interruptScroll, onPointerDown, onKeyDown };
}
