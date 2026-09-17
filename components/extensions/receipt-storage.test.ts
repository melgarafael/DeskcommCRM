import { describe, expect, it } from "vitest";

import {
  findPendingReceipt,
  persistPendingReceipt,
  readPendingReceipts,
  removePendingReceipt,
  type PendingReceipt,
} from "./receipt-storage";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value),
  };
}

const RECEIPT_A: PendingReceipt = {
  id: "00000000-0000-4000-8000-000000000001",
  kind: "install",
  label: "exemplo/guia@1.0.0",
  targetKey: "install:catalog:exemplo:guia:1.0.0",
  createdAt: "2026-09-15T00:00:00.000Z",
};

describe("armazenamento de recibos de extensão", () => {
  it("grava cada UUID em chave própria sem sobrescrever outra aba", () => {
    const storage = memoryStorage();
    const receiptB = { ...RECEIPT_A, id: "00000000-0000-4000-8000-000000000002" };

    persistPendingReceipt(storage, "actor-a", "org-a", RECEIPT_A);
    persistPendingReceipt(storage, "actor-a", "org-a", receiptB);

    expect(readPendingReceipts(storage, "actor-a", "org-a")).toEqual([RECEIPT_A, receiptB]);
  });

  it("isola recibos por ator e organização", () => {
    const storage = memoryStorage();
    persistPendingReceipt(storage, "actor-a", "org-a", RECEIPT_A);
    persistPendingReceipt(storage, "actor-b", "org-a", { ...RECEIPT_A, label: "outro ator" });
    persistPendingReceipt(storage, "actor-a", "org-b", { ...RECEIPT_A, label: "outra org" });

    expect(findPendingReceipt(storage, "actor-a", "org-a", RECEIPT_A.targetKey)).toEqual(RECEIPT_A);
    expect(readPendingReceipts(storage, "actor-b", "org-a")[0]?.label).toBe("outro ator");
    expect(readPendingReceipts(storage, "actor-a", "org-b")[0]?.label).toBe("outra org");
  });

  it("remove somente o UUID confirmado", () => {
    const storage = memoryStorage();
    const receiptB = { ...RECEIPT_A, id: "00000000-0000-4000-8000-000000000002" };
    persistPendingReceipt(storage, "actor-a", "org-a", RECEIPT_A);
    persistPendingReceipt(storage, "actor-a", "org-a", receiptB);

    removePendingReceipt(storage, "actor-a", "org-a", RECEIPT_A.id);

    expect(readPendingReceipts(storage, "actor-a", "org-a")).toEqual([receiptB]);
  });

  it("propaga falha de persistência antes que o chamador possa enviar a mutação", () => {
    const storage = memoryStorage();
    storage.setItem = () => {
      throw new DOMException("blocked", "SecurityError");
    };

    expect(() => persistPendingReceipt(storage, "actor-a", "org-a", RECEIPT_A)).toThrow();
  });
});
