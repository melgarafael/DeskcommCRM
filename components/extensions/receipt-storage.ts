import { ehTipoDeOperacao, type ExtensionOperationKind } from "@/lib/extensions/vocabulario";

export type PendingReceipt = {
  id: string;
  kind: ExtensionOperationKind;
  label: string;
  targetKey: string;
  createdAt: string;
};

const PREFIX = "extensions:pending:v2";

function namespace(actorId: string, organizationId: string): string {
  return `${PREFIX}:${actorId}:${organizationId}:`;
}

export function isReceiptStorageKey(
  key: string | null,
  actorId: string,
  organizationId: string,
): boolean {
  return key !== null && key.startsWith(namespace(actorId, organizationId));
}

function isPendingReceipt(value: unknown): value is PendingReceipt {
  if (typeof value !== "object" || value === null) return false;
  const receipt = value as PendingReceipt;
  return (
    typeof receipt.id === "string" &&
    typeof receipt.label === "string" &&
    typeof receipt.targetKey === "string" &&
    typeof receipt.createdAt === "string" &&
    ehTipoDeOperacao(receipt.kind)
  );
}

export function readPendingReceipts(
  storage: Storage,
  actorId: string,
  organizationId: string,
): PendingReceipt[] {
  const prefix = namespace(actorId, organizationId);
  const receipts: PendingReceipt[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith(prefix)) continue;
    const raw = storage.getItem(key);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (isPendingReceipt(parsed) && key === `${prefix}${parsed.id}`) receipts.push(parsed);
    } catch {
      // Entrada isolada inválida não apaga os outros recibos.
    }
  }
  return receipts.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function findPendingReceipt(
  storage: Storage,
  actorId: string,
  organizationId: string,
  targetKey: string,
): PendingReceipt | undefined {
  return readPendingReceipts(storage, actorId, organizationId).find(
    (receipt) => receipt.targetKey === targetKey,
  );
}

export function persistPendingReceipt(
  storage: Storage,
  actorId: string,
  organizationId: string,
  receipt: PendingReceipt,
): void {
  const key = `${namespace(actorId, organizationId)}${receipt.id}`;
  const serialized = JSON.stringify(receipt);
  storage.setItem(key, serialized);
  if (storage.getItem(key) !== serialized) {
    throw new Error("receipt_storage_unconfirmed");
  }
}

export function removePendingReceipt(
  storage: Storage,
  actorId: string,
  organizationId: string,
  receiptId: string,
): void {
  storage.removeItem(`${namespace(actorId, organizationId)}${receiptId}`);
}
