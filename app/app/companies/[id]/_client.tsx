"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useT } from "@/hooks/i18n/useT";

interface Props {
  id: string;
}

export function CompanyDetailClient({ id }: Props) {
  const t = useT();
  const [data, setData] = useState<{
    company: Record<string, unknown>;
    people: Array<Record<string, unknown>>;
    contacts: Array<Record<string, unknown>>;
  } | null>(null);
  const [enriching, setEnriching] = useState(false);
  const [campaigns, setCampaigns] = useState<
    Array<{
      recipient_id: string;
      campaign_id: string;
      campaign_name: string | null;
      person: string | null;
      phone: string;
      status: string;
      sent_at: string | null;
      replied_at: string | null;
    }>
  >([]);

  const load = useCallback(async () => {
    const res = await fetch(`/api/v1/companies/${id}`);
    const json = await res.json();
    if (res.ok) setData(json.data);
    const cRes = await fetch(`/api/v1/companies/${id}/campaigns`);
    const cJson = await cRes.json();
    if (cRes.ok && Array.isArray(cJson.data)) setCampaigns(cJson.data);
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function enrich() {
    setEnriching(true);
    await fetch(`/api/v1/companies/${id}/enrich`, { method: "POST" });
    setEnriching(false);
    void load();
  }

  if (!data) {
    return <div className="p-6 text-muted-foreground">{t("Carregando…")}</div>;
  }

  const c = data.company;

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href="/app/companies" className="text-sm text-muted-foreground hover:underline">
            ← {t("Empresas")}
          </Link>
          <h1 className="text-xl font-semibold">
            {(c.trade_name as string) || (c.legal_name as string) || t("Empresa")}
          </h1>
          <p className="font-mono text-sm text-muted-foreground">{(c.cnpj as string) || "—"}</p>
        </div>
        <Button variant="outline" onClick={() => void enrich()} disabled={enriching}>
          {enriching ? t("Enriquecendo…") : t("Enriquecer CNPJ")}
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="space-y-2 p-4">
          <h2 className="font-medium">{t("Dados cadastrais")}</h2>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-muted-foreground">{t("Razão social")}</dt>
            <dd>{(c.legal_name as string) || "—"}</dd>
            <dt className="text-muted-foreground">{t("Situação")}</dt>
            <dd>{(c.registration_status as string) || "—"}</dd>
            <dt className="text-muted-foreground">{t("Porte")}</dt>
            <dd>{(c.company_size as string) || "—"}</dd>
            <dt className="text-muted-foreground">CNAE</dt>
            <dd>
              {[c.main_cnae_code, c.main_cnae_description].filter(Boolean).join(" — ") || "—"}
            </dd>
            <dt className="text-muted-foreground">{t("Endereço")}</dt>
            <dd>
              {[c.street, c.number, c.district, c.city, c.state, c.zip_code]
                .filter(Boolean)
                .join(", ") || "—"}
            </dd>
            <dt className="text-muted-foreground">{t("Enriquecimento")}</dt>
            <dd>
              {(c.enrichment_status as string) || "—"}
              {c.enrichment_error ? ` — ${c.enrichment_error}` : ""}
            </dd>
          </dl>
        </Card>

        <Card className="space-y-2 p-4">
          <h2 className="font-medium">{t("Pessoas / decisores")}</h2>
          {data.people.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("Nenhuma pessoa vinculada.")}</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {data.people.map((p) => {
                const person = p.people as { id: string; full_name: string; email?: string } | null;
                return (
                  <li key={p.id as string} className="flex justify-between gap-2 border-b pb-2">
                    <div>
                      {person ? (
                        <Link className="font-medium hover:underline" href={`/app/people/${person.id}`}>
                          {person.full_name}
                        </Link>
                      ) : (
                        "—"
                      )}
                      <div className="text-muted-foreground">{(p.job_title as string) || ""}</div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card className="space-y-2 p-4 md:col-span-2">
          <h2 className="font-medium">{t("Telefones")}</h2>
          {data.contacts.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("Nenhum telefone ligado às pessoas desta empresa.")}</p>
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2 text-sm">
              {data.contacts.map((ct) => (
                <li key={ct.id as string} className="rounded border px-3 py-2">
                  <Link href={`/app/contacts/${ct.id}`} className="font-mono hover:underline">
                    {(ct.phone_number as string) || "—"}
                  </Link>
                  <div className="text-muted-foreground">
                    {(ct.display_name as string) || (ct.name as string) || ""}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="space-y-2 p-4 md:col-span-2">
          <h2 className="font-medium">{t("Campanhas")}</h2>
          {campaigns.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("Nenhuma participação em campanha ainda.")}
            </p>
          ) : (
            <ul className="space-y-2 text-sm">
              {campaigns.map((row) => (
                <li
                  key={row.recipient_id}
                  className="flex flex-wrap items-baseline justify-between gap-2 border-b pb-2"
                >
                  <div>
                    <Link
                      href={`/app/whatsapp-campaigns/${row.campaign_id}`}
                      className="font-medium hover:underline"
                    >
                      {row.campaign_name || row.campaign_id.slice(0, 8)}
                    </Link>
                    <div className="text-muted-foreground">
                      {row.person || "—"} · {row.phone} · {row.status}
                      {row.replied_at
                        ? ` · ${t("Resposta")}: ${new Date(row.replied_at).toLocaleString()}`
                        : ""}
                    </div>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {row.sent_at
                      ? new Date(row.sent_at).toLocaleDateString()
                      : "—"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
