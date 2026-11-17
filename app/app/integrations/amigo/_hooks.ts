"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { randomId } from "@/lib/random-id";
import { AmigoUiError, errorText, execute } from "./_api";
import type { AmigoOperation, Receipt } from "./_types";
import { useMutationBlock } from "./_mutation-boundary";
export function useLoad<T>(loader: () => Promise<T>, enabled = true) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    if (!enabled) {
      setData(null);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const value = await loader();
      if (current === generation.current) setData(value);
    } catch (e) {
      if (current === generation.current) {
        setError(errorText(e));
        setData(null);
      }
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [loader, enabled]);
  useEffect(() => {
    const tracker = generation;
    let active = true;
    queueMicrotask(() => {
      if (active) void refresh();
    });
    return () => {
      active = false;
      tracker.current++;
    };
  }, [refresh]);
  return { data, error, loading, refresh };
}
export function useAmigoMutation() {
  const scope = useMutationBlock();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const lock = useRef(false);
  const keys = useRef(new Map<string, string>());
  const last = useRef<{
    operation: AmigoOperation;
    input: Record<string, unknown>;
    contactId?: string;
  } | null>(null);
  const [blocked, setBlocked] = useState(false);
  const uncertain = useRef(false);
  const onConfirmed = (value: Receipt) => {
    uncertain.current = false;
    setBlocked(false);
    setError("");
    setReceipt(value);
  };
  const run = async (
    operation: AmigoOperation,
    input: Record<string, unknown>,
    contactId?: string,
    checking = false,
  ): Promise<Receipt | null> => {
    if (lock.current || ((uncertain.current || scope?.blocked) && !checking)) return null;
    lock.current = true;
    setPending(true);
    setError("");
    setReceipt(null);
    last.current = { operation, input, contactId };
    const fingerprint = JSON.stringify([operation, input, contactId]);
    const key = keys.current.get(fingerprint) ?? randomId();
    keys.current.set(fingerprint, key);
    try {
      const value = await execute(operation, input, key, contactId);
      setReceipt(value);
      uncertain.current = !!value.uncertain;
      setBlocked(uncertain.current);
      if (value.uncertain) {
        scope?.report({
          operation,
          input,
          key,
          contactId,
          protocol: value.operation_id,
          onConfirmed,
        });
        setError(errorText(new AmigoUiError("uncertain", true)));
        return null;
      }
      scope?.resolve(key);
      return value;
    } catch (e) {
      uncertain.current = e instanceof AmigoUiError && e.uncertain;
      if (uncertain.current) scope?.report({ operation, input, key, contactId, onConfirmed });
      else if (e instanceof AmigoUiError && e.code === "amigo_rejected") scope?.resolve(key);
      setBlocked(uncertain.current);
      setError(errorText(e));
      return null;
    } finally {
      lock.current = false;
      setPending(false);
    }
  };
  return {
    pending,
    blocked: blocked || !!scope?.blocked,
    error,
    receipt,
    run,
    retry: () =>
      last.current
        ? run(last.current.operation, last.current.input, last.current.contactId, true)
        : Promise.resolve(null),
  };
}
