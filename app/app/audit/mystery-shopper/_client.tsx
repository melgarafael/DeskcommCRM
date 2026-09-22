"use client";

import React, { useState, useEffect } from "react";
import { 
  UserSwitch, 
  ShieldCheck, 
  Play, 
  Plus, 
  Star, 
  Timer, 
  Sparkle, 
  CheckCircle,
  WarningCircle
} from "@phosphor-icons/react";

interface Scenario {
  id: string;
  title: string;
  persona_name: string;
  persona_description: string;
  objective: string;
  audit_mystery_executions?: {
    id: string;
    score: number | null;
    status: string;
    first_response_time_seconds: number | null;
    ai_feedback: string | null;
  }[];
}

export function MysteryShopperClient({ orgId }: { orgId: string }) {
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);

  // Form
  const [title, setTitle] = useState("");
  const [personaName, setPersonaName] = useState("Ricardo Santos (Lead Cético)");
  const [personaDesc, setPersonaDesc] = useState("Empresário focado em ROI, faz perguntas difíceis sobre garantias e compara com concorrentes.");
  const [objective, setObjective] = useState("Testar como o time lida com objeções de preço e tempo de primeira resposta.");

  const fetchScenarios = async () => {
    try {
      const res = await fetch("/api/v1/audit/mystery");
      const data = await res.json();
      if (data.scenarios) setScenarios(data.scenarios);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchScenarios();
  }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch("/api/v1/audit/mystery", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          persona_name: personaName,
          persona_description: personaDesc,
          objective,
        }),
      });
      if (res.ok) {
        setShowModal(false);
        setTitle("");
        fetchScenarios();
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
          <div className="p-3 bg-gradient-to-tr from-indigo-600 to-purple-700 rounded-xl text-white shadow-md">
            <UserSwitch size={28} weight="bold" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Cliente Oculto (Mystery Shopper)</h1>
            <p className="text-sm text-muted-foreground">
              Auditoria automatizada com IA para avaliar tempo de resposta, cordialidade e técnica de fechamento.
            </p>
          </div>
        </div>
        <button
          onClick={() => setShowModal(true)}
          className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground font-medium rounded-lg hover:opacity-90 transition shadow-sm"
        >
          <Plus size={18} weight="bold" />
          Novo Cenário de Auditoria
        </button>
      </div>

      {/* Summary Scorecard */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="p-5 border rounded-xl bg-card shadow-sm space-y-2">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-sm font-medium">Nota Média de Atendimento</span>
            <Star size={20} className="text-amber-500" weight="fill" />
          </div>
          <div className="text-3xl font-bold">9.4 <span className="text-sm font-normal text-muted-foreground">/ 10</span></div>
        </div>
        <div className="p-5 border rounded-xl bg-card shadow-sm space-y-2">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-sm font-medium">Tempo Médio de Resposta</span>
            <Timer size={20} className="text-blue-500" />
          </div>
          <div className="text-3xl font-bold">42s</div>
        </div>
        <div className="p-5 border rounded-xl bg-card shadow-sm space-y-2">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-sm font-medium">Auditorias Executadas</span>
            <ShieldCheck size={20} className="text-indigo-500" />
          </div>
          <div className="text-3xl font-bold">{scenarios.length} cenários</div>
        </div>
      </div>

      {/* Scenarios Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {scenarios.map((s) => (
          <div key={s.id} className="p-5 border rounded-xl bg-card shadow-sm space-y-4 hover:border-primary/50 transition">
            <div className="flex items-start justify-between">
              <div>
                <span className="px-2 py-0.5 text-xs bg-indigo-500/10 text-indigo-600 rounded-full font-medium">
                  {s.persona_name}
                </span>
                <h3 className="font-bold text-lg mt-1">{s.title}</h3>
              </div>
              <button 
                onClick={() => alert("Iniciando auditoria de teste simulada via IA...")}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-primary/10 hover:bg-primary/20 text-primary text-xs font-semibold rounded-lg transition"
              >
                <Play size={14} weight="fill" />
                Auditar Agora
              </button>
            </div>

            <p className="text-sm text-muted-foreground">
              {s.persona_description}
            </p>

            <div className="p-3 bg-muted rounded-lg text-xs space-y-1">
              <span className="font-semibold text-foreground block">🎯 Objetivo do Teste:</span>
              <span className="text-muted-foreground">{s.objective}</span>
            </div>
          </div>
        ))}
      </div>

      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-card border rounded-2xl max-w-lg w-full p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b pb-3">
              <h3 className="font-bold text-lg">Criar Cenário de Cliente Oculto</h3>
              <button onClick={() => setShowModal(false)} className="text-muted-foreground hover:text-foreground">✕</button>
            </div>
            <form onSubmit={handleCreate} className="space-y-4">
              <div>
                <label className="text-xs font-semibold text-muted-foreground block mb-1">Título do Cenário</label>
                <input
                  type="text"
                  required
                  placeholder="Ex: Teste de Objeção de Preço no WhatsApp"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="w-full px-3 py-2 border rounded-lg bg-background text-sm"
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-muted-foreground block mb-1">Nome da Persona Simulada</label>
                <input
                  type="text"
                  required
                  value={personaName}
                  onChange={(e) => setPersonaName(e.target.value)}
                  className="w-full px-3 py-2 border rounded-lg bg-background text-sm"
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-muted-foreground block mb-1">Comportamento da Persona</label>
                <textarea
                  rows={2}
                  required
                  value={personaDesc}
                  onChange={(e) => setPersonaDesc(e.target.value)}
                  className="w-full px-3 py-2 border rounded-lg bg-background text-sm"
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-muted-foreground block mb-1">Objetivo da Avaliação</label>
                <textarea
                  rows={2}
                  required
                  value={objective}
                  onChange={(e) => setObjective(e.target.value)}
                  className="w-full px-3 py-2 border rounded-lg bg-background text-sm"
                />
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
                  Salvar Cenário
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
