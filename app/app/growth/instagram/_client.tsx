"use client";

import React, { useState, useEffect } from "react";
import {
  InstagramLogo,
  ChatCircleDots,
  Lightning,
  Plus,
  Funnel,
  CheckCircle,
  Tag,
  Users,
} from "@phosphor-icons/react";
import { useT } from "@/hooks/i18n/useT";

interface Trigger {
  id: string;
  name: string;
  post_id: string | null;
  keywords: string[];
  match_mode: string;
  dm_response_template: string;
  auto_create_lead: boolean;
  executions_count: number;
  leads_generated_count: number;
  is_active: boolean;
}

export function InstagramGrowthClient({ orgId }: { orgId: string }) {
  const t = useT();
  const [triggers, setTriggers] = useState<Trigger[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);

  // Form State
  const [name, setName] = useState("");
  const [keywords, setKeywords] = useState("EU QUERO, PREÇO, QUERO");
  const [dmTemplate, setDmTemplate] = useState(
    "Olá! Vi seu comentário no nosso post. Aqui está o link exclusivo que você pediu: https://saraiva.ai",
  );
  const [autoLead, setAutoLead] = useState(true);

  const fetchTriggers = async () => {
    try {
      const res = await fetch("/api/v1/growth/instagram");
      const data = await res.json();
      if (data.triggers) setTriggers(data.triggers);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTriggers();
  }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch("/api/v1/growth/instagram", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          keywords: keywords
            .split(",")
            .map((k) => k.trim())
            .filter(Boolean),
          dm_response_template: dmTemplate,
          auto_create_lead: autoLead,
          match_mode: "contains",
        }),
      });
      if (res.ok) {
        setShowModal(false);
        setName("");
        fetchTriggers();
      }
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <div className="mx-auto max-w-7xl flex-1 space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between border-b pb-4">
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-gradient-to-tr from-yellow-500 via-pink-500 to-purple-600 p-3 text-white shadow-md">
            <InstagramLogo size={28} weight="bold" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">{t("Instagram Growth Engine")}</h1>
            <p className="text-sm text-muted-foreground">
              {t(
                "Converta automaticamente comentários de Reels e Posts em DMs e Leads no seu CRM.",
              )}
            </p>
          </div>
        </div>
        <button
          onClick={() => setShowModal(true)}
          className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 font-medium text-primary-foreground shadow-sm transition hover:opacity-90"
        >
          <Plus size={18} weight="bold" />
          {t("Novo Gatilho de Comentário")}
        </button>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="space-y-2 rounded-xl border bg-card p-5 shadow-sm">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-sm font-medium">{t("Gatilhos Ativos")}</span>
            <Lightning size={20} className="text-amber-500" />
          </div>
          <div className="text-3xl font-bold">{triggers.filter((t) => t.is_active).length}</div>
        </div>
        <div className="space-y-2 rounded-xl border bg-card p-5 shadow-sm">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-sm font-medium">{t("DMs Disparadas")}</span>
            <ChatCircleDots size={20} className="text-blue-500" />
          </div>
          <div className="text-3xl font-bold">
            {triggers.reduce((acc, t) => acc + (t.executions_count || 0), 0)}
          </div>
        </div>
        <div className="space-y-2 rounded-xl border bg-card p-5 shadow-sm">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-sm font-medium">{t("Leads Gerados")}</span>
            <Users size={20} className="text-emerald-500" />
          </div>
          <div className="text-3xl font-bold">
            {triggers.reduce((acc, t) => acc + (t.leads_generated_count || 0), 0)}
          </div>
        </div>
      </div>

      {/* Triggers List */}
      <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
        <div className="flex items-center justify-between border-b p-4 font-semibold">
          <span>{t("Regras de Automação de Comentários")}</span>
          <span className="text-xs text-muted-foreground">
            {triggers.length} {t("cadastradas")}
          </span>
        </div>

        {loading ? (
          <div className="p-8 text-center text-muted-foreground">{t("Carregando gatilhos...")}</div>
        ) : triggers.length === 0 ? (
          <div className="space-y-3 p-12 text-center">
            <div className="inline-flex rounded-full bg-muted p-3 text-muted-foreground">
              <InstagramLogo size={32} />
            </div>
            <h3 className="text-lg font-semibold">{t("Nenhum gatilho de Instagram ativo")}</h3>
            <p className="mx-auto max-w-md text-sm text-muted-foreground">
              {t(
                'Crie seu primeiro gatilho para responder comentários como "EU QUERO" ou "PREÇO" enviando uma DM instantânea com seu link.',
              )}
            </p>
            <button
              onClick={() => setShowModal(true)}
              className="mt-2 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
            >
              <Plus size={16} weight="bold" />
              {t("Criar Primeiro Gatilho")}
            </button>
          </div>
        ) : (
          <div className="divide-y">
            {triggers.map((trigger) => (
              <div
                key={trigger.id}
                className="flex items-center justify-between p-4 transition hover:bg-muted/50"
              >
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">{trigger.name}</span>
                    <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-600">
                      {t("Ativo")}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Tag size={14} />
                    <span>{t("Palavras-chave:")} </span>
                    <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-foreground">
                      {trigger.keywords.join(", ")}
                    </span>
                  </div>
                  <p className="line-clamp-1 text-xs text-muted-foreground italic">
                    "{trigger.dm_response_template}"
                  </p>
                </div>
                <div className="space-y-1 text-right">
                  <div className="text-sm font-semibold">
                    {trigger.executions_count} DMs / {trigger.leads_generated_count} Leads
                  </div>
                  <div className="text-xs text-muted-foreground">{t("Automação nativa")}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Modal Criar Gatilho */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
          <div className="w-full max-w-lg space-y-4 rounded-2xl border bg-card p-6 shadow-2xl">
            <div className="flex items-center justify-between border-b pb-3">
              <h3 className="text-lg font-bold">{t("Criar Gatilho de Comentário (Instagram)")}</h3>
              <button
                onClick={() => setShowModal(false)}
                className="text-muted-foreground hover:text-foreground"
              >
                ✕
              </button>
            </div>
            <form onSubmit={handleCreate} className="space-y-4">
              <div>
                <label className="mb-1 block text-xs font-semibold text-muted-foreground">
                  {t("Nome da Regra")}
                </label>
                <input
                  type="text"
                  required
                  placeholder={t("Ex: Campanha Reels - Curso IA")}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus:ring-2 focus:ring-primary focus:outline-hidden"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold text-muted-foreground">
                  {t("Palavras-chave Gatilho (separadas por vírgula)")}
                </label>
                <input
                  type="text"
                  required
                  placeholder={t("EU QUERO, PREÇO, AULA, ME MANDA")}
                  value={keywords}
                  onChange={(e) => setKeywords(e.target.value)}
                  className="w-full rounded-lg border bg-background px-3 py-2 font-mono text-sm focus:ring-2 focus:ring-primary focus:outline-hidden"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold text-muted-foreground">
                  {t("Mensagem enviada na DM")}
                </label>
                <textarea
                  rows={3}
                  required
                  value={dmTemplate}
                  onChange={(e) => setDmTemplate(e.target.value)}
                  className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus:ring-2 focus:ring-primary focus:outline-hidden"
                />
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="autoLead"
                  checked={autoLead}
                  onChange={(e) => setAutoLead(e.target.checked)}
                  className="rounded-md border-gray-300 text-primary focus:ring-primary"
                />
                <label htmlFor="autoLead" className="text-sm font-medium">
                  {t("Criar Lead automaticamente no Funil de Vendas ao enviar a DM")}
                </label>
              </div>

              <div className="flex justify-end gap-2 border-t pt-2">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="rounded-lg border px-4 py-2 text-sm font-medium hover:bg-muted"
                >
                  {t("Cancelar")}
                </button>
                <button
                  type="submit"
                  className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
                >
                  {t("Salvar e Ativar Gatilho")}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
