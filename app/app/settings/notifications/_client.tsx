"use client";

import { useT } from "@/hooks/i18n/useT";

import { useSyncExternalStore } from "react";

import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useNotificationPermission } from "@/hooks/notifications/useNotificationPermission";
import {
  NOTIFY_UI_CATEGORIES,
  assinarPrefs,
  getPrefsSnapshot,
  getPrefsSnapshotDoServidor,
  gravarCanal,
  type NotifyCategory,
  type NotifyChannelPref,
} from "@/lib/notifications/prefs";

const LABELS: Record<NotifyCategory, string> = {
  message: "Nova mensagem",
  lead_assigned: "Lead atribuído a você",
  lead_won: "Lead ganho",
  lead_lost: "Lead perdido",
  mention: "Você foi mencionado",
};

export function NotificationPrefsClient() {
  const t = useT();
  const { permission, request } = useNotificationPermission();
  const prefs = useSyncExternalStore(assinarPrefs, getPrefsSnapshot, getPrefsSnapshotDoServidor);
  const denied = permission === "denied";
  const unsupported = permission === "unsupported";

  async function onToggle(category: NotifyCategory, channel: NotifyChannelPref, on: boolean) {
    if (channel === "push" && on) {
      if (permission !== "granted") {
        const next = await request();
        if (next !== "granted") return;
      }
    }
    gravarCanal(category, channel, on);
  }

  return (
    <Card className="p-0">
      <table className="w-full text-sm">
        <thead className="border-b">
          <tr>
            <th className="px-4 py-3 text-left font-medium">{t("Categoria")}</th>
            <th className="px-4 py-3 text-center font-medium">Email</th>
            <th className="px-4 py-3 text-center font-medium">In-app</th>
            <th className="px-4 py-3 text-center font-medium">Push</th>
          </tr>
        </thead>
        <tbody>
          {NOTIFY_UI_CATEGORIES.map((cat) => (
            <tr key={cat} className="border-b last:border-0">
              <td className="px-4 py-3">
                {t(LABELS[cat])}
                {cat === "message" && denied ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t(
                      "O navegador bloqueou as notificações. Libere-as nas configurações do site e recarregue.",
                    )}
                  </p>
                ) : null}
              </td>
              <td className="px-4 py-3 text-center">
                <Switch checked={false} disabled aria-label={`${t(LABELS[cat])} via email`} />
              </td>
              <td className="px-4 py-3 text-center">
                <Switch
                  checked={prefs[cat].in_app}
                  onCheckedChange={(on) => void onToggle(cat, "in_app", on)}
                  aria-label={`${t(LABELS[cat])} via in_app`}
                />
              </td>
              <td className="px-4 py-3 text-center">
                <Switch
                  checked={prefs[cat].push}
                  disabled={denied || unsupported}
                  onCheckedChange={(on) => void onToggle(cat, "push", on)}
                  aria-label={`${t(LABELS[cat])} via push`}
                  data-testid={cat === "message" ? (prefs.message.push ? "alerts-toggle" : "alerts-enable") : undefined}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
