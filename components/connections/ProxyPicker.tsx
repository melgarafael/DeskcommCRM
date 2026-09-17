"use client";
import { useT } from "@/hooks/i18n/useT";

export interface ProxyOptions {
  enabled: boolean;
  required: boolean;
  proxies: { id: string; country: string; available: boolean }[];
  bindings: { channel_session_id: string; proxy_id: string; country_code: string }[];
}
export function ProxyPicker({ options, country, currentId, onChange }: {
  options: ProxyOptions; country: string; currentId?: string;
  onChange: (country: string) => void;
}) {
  const t = useT();
  const countries = [...new Set(options.proxies.map(p => p.country))].sort();
  return <div className="flex flex-col gap-3">
    <p className="text-sm text-muted-foreground">{t("Escolha o país. Um proxy livre será selecionado automaticamente.")}</p>
    <label className="flex flex-col gap-1 text-sm">{t("País do proxy")}
      <select className="rounded-md border bg-background p-2 text-foreground" value={country} onChange={e => onChange(e.target.value)}>
        <option value="">{t("Selecione o país")}</option>
        {countries.map(c => <option key={c} value={c}>{c}</option>)}
      </select>
    </label>
    {country && !options.proxies.some(p => p.country === country && (p.available || p.id === currentId)) &&
      <p role="status" className="text-sm text-error-fg">{t("Não há proxy disponível neste país. Escolha outro país ou tente novamente mais tarde.")}</p>}
  </div>;
}
