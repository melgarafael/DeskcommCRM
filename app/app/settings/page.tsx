import { Gear } from "@/lib/ui/icons";

export default function SettingsPlaceholderPage() {
  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <Gear size={48} className="text-muted-foreground" weight="duotone" />
      <h1 className="mt-4 text-xl font-semibold">Configurações</h1>
      <p className="mt-2 max-w-sm text-sm text-muted-foreground">
        Tela em construção. Será entregue em waves seguintes (Settings, LGPD, Channels, etc).
      </p>
    </div>
  );
}
