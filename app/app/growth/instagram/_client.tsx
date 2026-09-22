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
  Users 
} from "@phosphor-icons/react";

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
  const [triggers, setTriggers] = useState<Trigger[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);

  // Form State
  const [name, setName] = useState("");
  const [keywords, setKeywords] = useState("EU QUERO, PREÇO, QUERO");
  const [dmTemplate, setDmTemplate] = useState("Olá! Vi seu comentário no nosso post. Aqui está o link exclusivo que você pediu: https://saraiva.ai");
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
          keywords: keywords.split(",").map(k => k.trim()).filter(Boolean),
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
    <div className="flex-1 p-6 space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between border-b pb-4">
        <div className="flex items-center gap-3">
          <div className="p-3 bg-gradient-to-tr from-yellow-500 via-pink-500 to-purple-600 rounded-xl text-white shadow-md">
            <InstagramLogo size={28} weight="bold" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Instagram Growth Engine</h1>
            <p className="text-sm text-muted-foreground">
              Converta automaticamente comentários de Reels e Posts em DMs e Leads no seu CRM.
            </p>
          </div>
        </div>
        <button
          onClick={() => setShowModal(true)}
          className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground font-medium rounded-lg hover:opacity-90 transition shadow-sm"
        >
          <Plus size={18} weight="bold" />
          Novo Gatilho de Comentário
        </button>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="p-5 border rounded-xl bg-card shadow-sm space-y-2">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-sm font-medium">Gatilhos Ativos</span>
            <Lightning size={20} className="text-amber-500" />
          </div>
          <div className="text-3xl font-bold">{triggers.filter(t => t.is_active).length}</div>
        </div>
        <div className="p-5 border rounded-xl bg-card shadow-sm space-y-2">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-sm font-medium">DMs Disparadas</span>
            <ChatCircleDots size={20} className="text-blue-500" />
          </div>
          <div className="text-3xl font-bold">
            {triggers.reduce((acc, t) => acc + (t.executions_count || 0), 0)}
          </div>
        </div>
        <div className="p-5 border rounded-xl bg-card shadow-sm space-y-2">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-sm font-medium">Leads Gerados</span>
            <Users size={20} className="text-emerald-500" />
          </div>
          <div className="text-3xl font-bold">
            {triggers.reduce((acc, t) => acc + (t.leads_generated_count || 0), 0)}
          </div>
        </div>
      </div>

      {/* Triggers List */}
      <div className="border rounded-xl bg-card shadow-sm overflow-hidden">
        <div className="p-4 border-b font-semibold flex items-center justify-between">
          <span>Regras de Automação de Comentários</span>
          <span className="text-xs text-muted-foreground">{triggers.length} cadastradas</span>
        </div>

        {loading ? (
          <div className="p-8 text-center text-muted-foreground">Carregando gatilhos...</div>
        ) : triggers.length === 0 ? (
          <div className="p-12 text-center space-y-3">
            <div className="inline-flex p-3 rounded-full bg-muted text-muted-foreground">
              <InstagramLogo size={32} />
            </div>
            <h3 className="font-semibold text-lg">Nenhum gatilho de Instagram ativo</h3>
            <p className="text-sm text-muted-foreground max-w-md mx-auto">
              Crie seu primeiro gatilho para responder comentários como "EU QUERO" ou "PREÇO" enviando uma DM instantânea com seu link.
            </p>
            <button
              onClick={() => setShowModal(true)}
              className="mt-2 inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground text-sm font-medium rounded-lg"
            >
              <Plus size={16} weight="bold" />
              Criar Primeiro Gatilho
            </button>
          </div>
        ) : (
          <div className="divide-y">
            {triggers.map((t) => (
              <div key={t.id} className="p-4 flex items-center justify-between hover:bg-muted/50 transition">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">{t.name}</span>
                    <span className="px-2 py-0.5 text-xs bg-emerald-500/10 text-emerald-600 rounded-full font-medium">
                      Ativo
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Tag size={14} />
                    <span>Palavras-chave: </span>
                    <span className="font-mono bg-muted px-1.5 py-0.5 rounded text-foreground">
                      {t.keywords.join(", ")}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground line-clamp-1 italic">
                    "{t.dm_response_template}"
                  </p>
                </div>
                <div className="text-right space-y-1">
                  <div className="text-sm font-semibold">{t.executions_count} DMs / {t.leads_generated_count} Leads</div>
                  <div className="text-xs text-muted-foreground">Automação nativa</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Modal Criar Gatilho */}
      {showModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-card border rounded-2xl max-w-lg w-full p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b pb-3">
              <h3 className="font-bold text-lg">Criar Gatilho de Comentário (Instagram)</h3>
              <button onClick={() => setShowModal(false)} className="text-muted-foreground hover:text-foreground">✕</button>
            </div>
            <form onSubmit={handleCreate} className="space-y-4">
              <div>
                <label className="text-xs font-semibold text-muted-foreground block mb-1">Nome da Regra</label>
                <input
                  type="text"
                  required
                  placeholder="Ex: Campanha Reels - Curso IA"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full px-3 py-2 border rounded-lg bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-muted-foreground block mb-1">Palavras-chave Gatilho (separadas por vírgula)</label>
                <input
                  type="text"
                  required
                  placeholder="EU QUERO, PREÇO, AULA, ME MANDA"
                  value={keywords}
                  onChange={(e) => setKeywords(e.target.value)}
                  className="w-full px-3 py-2 border rounded-lg bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary font-mono"
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-muted-foreground block mb-1">Mensagem enviada na DM</label>
                <textarea
                  rows={3}
                  required
                  value={dmTemplate}
                  onChange={(e) => setDmTemplate(e.target.value)}
                  className="w-full px-3 py-2 border rounded-lg bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="autoLead"
                  checked={autoLead}
                  onChange={(e) => setAutoLead(e.target.checked)}
                  className="rounded border-gray-300 text-primary focus:ring-primary"
                />
                <label htmlFor="autoLead" className="text-sm font-medium">
                  Criar Lead automaticamente no Funil de Vendas ao enviar a DM
                </label>
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="px-4 py-2 border rounded-lg text-sm font-medium hover:bg-muted"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-primary text-primary-foreground text-sm font-medium rounded-lg hover:opacity-90"
                >
                  Salvar e Ativar Gatilho
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
