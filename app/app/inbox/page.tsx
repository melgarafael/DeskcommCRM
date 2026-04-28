import { Inbox } from "@/lib/ui/icons";

export default function InboxPlaceholderPage() {
  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <Inbox size={48} className="text-muted-foreground" weight="duotone" />
      <h1 className="mt-4 text-xl font-semibold">Inbox</h1>
      <p className="mt-2 max-w-sm text-sm text-muted-foreground">
        Tela em construção. Será entregue no EPIC-03 (Inbox + Messaging).
      </p>
    </div>
  );
}
