"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { salvarAntecedencia } from "@/app/actions/agencia/avisos";
import { enviarTesteDoWhatsapp, salvarWhatsappDaAgencia } from "@/app/actions/agencia/whatsapp";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export interface CanalDaLista {
  id: string;
  rotulo: string;
  conectado: boolean;
}

export interface EnvioDaLista {
  id: string;
  motivo: string;
  telefone: string;
  situacao: string;
  erro_codigo: string | null;
  criado_em: string;
  enviado_em: string | null;
}

const SITUACAO: Record<string, string> = {
  pendente: "Na fila",
  enviado: "Enviado",
  falhou: "Falhou",
  descartado: "Descartado",
};

/** O motivo de cada falha, em português — a tela nunca mostra código cru. */
const MOTIVO_DA_FALHA: Record<string, string> = {
  sem_configuracao: "o WhatsApp da agência não estava configurado",
  canal_indisponivel: "o WhatsApp escolhido foi desconectado",
  canal_sem_mensagem_livre: "esse canal não aceita mensagem livre (API oficial fora da janela)",
  transporte_ausente: "o WhatsApp ficou fora do ar",
  destino_invalido: "o número não existe no WhatsApp",
  envio_recusado: "o WhatsApp recusou o envio",
  envio_velho: "ficou mais de 24 h sem sair",
  evento_nao_gravado: "não entrou na fila",
};

const MOTIVO: Record<string, string> = { convite: "Convite", aviso: "Aviso", teste: "Teste" };

function dataCurta(iso: string): string {
  return new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function ConfiguracoesCliente({
  canais,
  inicial,
  envios,
}: {
  canais: CanalDaLista[];
  inicial: { canalId: string | null; janelaInicio: string; janelaFim: string; antecedencia: number[] };
  envios: EnvioDaLista[];
}) {
  const router = useRouter();
  const [canalId, setCanalId] = useState(inicial.canalId ?? "");
  const [inicio, setInicio] = useState(inicial.janelaInicio);
  const [fim, setFim] = useState(inicial.janelaFim);
  const [dias, setDias] = useState<number[]>(inicial.antecedencia);
  const [msg, setMsg] = useState<{ ok: boolean; texto: string; onde: "whatsapp" | "avisos" } | null>(null);
  const [pendente, startTransition] = useTransition();

  function salvarWhatsapp(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const r = await salvarWhatsappDaAgencia({ canalId: canalId || null, janelaInicio: inicio, janelaFim: fim });
      setMsg({ ok: r.ok, texto: r.ok ? "WhatsApp da agência salvo." : r.erro, onde: "whatsapp" });
      router.refresh();
    });
  }

  function testar() {
    startTransition(async () => {
      const r = await enviarTesteDoWhatsapp();
      setMsg({
        ok: r.ok,
        texto: r.ok ? "Teste na fila. Ele aparece em Últimos envios em instantes." : r.erro,
        onde: "whatsapp",
      });
      router.refresh();
    });
  }

  function alternarDia(d: number) {
    setDias((atual) => (atual.includes(d) ? atual.filter((x) => x !== d) : [...atual, d].sort((a, b) => b - a)));
  }

  function salvarAvisos() {
    startTransition(async () => {
      const r = await salvarAntecedencia(dias);
      setMsg({ ok: r.ok, texto: r.ok ? "Antecedência salva." : r.erro, onde: "avisos" });
      router.refresh();
    });
  }

  return (
    <div className="space-y-6">
      <form onSubmit={salvarWhatsapp} className="space-y-4 rounded-md border p-4">
        <div className="space-y-1">
          <h2 className="font-semibold">WhatsApp da agência</h2>
          <p className="text-sm text-muted-foreground">
            O número que manda convites e avisos para a equipe. Ele precisa estar conectado em alguma organização da central.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="canal">WhatsApp</Label>
          <select
            id="canal"
            value={canalId}
            onChange={(e) => setCanalId(e.target.value)}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          >
            <option value="">Nenhum (convites mostram o link para copiar)</option>
            {canais.map((c) => (
              <option key={c.id} value={c.id}>
                {c.rotulo}
                {c.conectado ? "" : " — desconectado"}
              </option>
            ))}
          </select>
          {canais.length === 0 && (
            <p className="text-xs text-muted-foreground">
              Nenhum WhatsApp conectado. Conecte o número da agência por QR Code em Conexões, dentro da organização da agência.
            </p>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="inicio">Avisos a partir de</Label>
            <Input id="inicio" type="time" value={inicio} onChange={(e) => setInicio(e.target.value)} required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="fim">Avisos até</Label>
            <Input id="fim" type="time" value={fim} onChange={(e) => setFim(e.target.value)} required />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Aviso criado fora deste horário espera a abertura. Convite e teste saem na hora.
        </p>
        {msg?.onde === "whatsapp" && (
          <p role="status" className={msg.ok ? "text-sm text-muted-foreground" : "text-sm text-destructive"}>
            {msg.texto}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" disabled={pendente || !inicial.canalId} onClick={testar}>
            Enviar teste para mim
          </Button>
          <Button type="submit" disabled={pendente}>
            Salvar
          </Button>
        </div>
      </form>

      <section className="space-y-4 rounded-md border p-4">
        <div className="space-y-1">
          <h2 className="font-semibold">Avisos de prazo</h2>
          <p className="text-sm text-muted-foreground">
            Quantos dias antes do prazo a equipe é avisada. "No dia" e "atrasou" são sempre avisados. Passam a valer quando as
            tarefas chegarem.
          </p>
        </div>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Dias de antecedência">
          {[7, 6, 5, 4, 3, 2, 1].map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={dias.includes(d)}
              onClick={() => alternarDia(d)}
              className={cn(
                "min-h-10 rounded-full border px-3 text-sm",
                dias.includes(d) ? "border-foreground bg-foreground text-background" : "text-muted-foreground",
              )}
            >
              {d === 1 ? "1 dia antes" : `${d} dias antes`}
            </button>
          ))}
        </div>
        {msg?.onde === "avisos" && (
          <p role="status" className={msg.ok ? "text-sm text-muted-foreground" : "text-sm text-destructive"}>
            {msg.texto}
          </p>
        )}
        <div className="flex justify-end">
          <Button type="button" disabled={pendente} onClick={salvarAvisos}>
            Salvar antecedência
          </Button>
        </div>
      </section>

      <section className="space-y-3 rounded-md border p-4">
        <h2 className="font-semibold">Últimos envios</h2>
        {envios.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nada enviado ainda.</p>
        ) : (
          <ul className="divide-y text-sm">
            {envios.map((e) => (
              <li key={e.id} className="flex flex-col gap-0.5 py-2 sm:flex-row sm:items-center sm:justify-between">
                <span>
                  {MOTIVO[e.motivo] ?? e.motivo} para {e.telefone}
                  {e.situacao === "falhou" || e.situacao === "descartado" ? (
                    <span className="block text-xs text-destructive">
                      {MOTIVO_DA_FALHA[e.erro_codigo ?? ""] ?? "não saiu"}
                    </span>
                  ) : null}
                </span>
                <span className="text-xs text-muted-foreground">
                  {SITUACAO[e.situacao] ?? e.situacao} · {dataCurta(e.enviado_em ?? e.criado_em)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
