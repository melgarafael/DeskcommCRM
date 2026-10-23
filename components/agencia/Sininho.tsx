"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import {
  listarMeusAvisos,
  marcarAvisoComoLido,
  marcarTodosComoLidos,
  type AvisoDoSininho as Aviso,
} from "@/app/actions/agencia/sininho";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useRealtimeChannel } from "@/hooks/realtime/useRealtimeChannel";
import { Bell } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

/**
 * O sininho da área da agência (docs/agencia/SPEC-avisos.md › Tela).
 *
 * Lê e marca pelo SERVIDOR (`app/actions/agencia/sininho.ts`): o cookie de
 * sessão é HttpOnly, e a leitura direta pelo client do navegador saía como
 * `anon` (401, medido no teste). O Realtime só avisa que chegou coisa nova; e,
 * como rede de segurança para um canal que caiu calado, o sininho também relê
 * ao voltar o foco para a aba e a cada minuto.
 */
const RELEITURA_MS = 60_000;

function quando(iso: string): string {
  const d = new Date(iso);
  const min = Math.round((Date.now() - d.getTime()) / 60_000);
  if (min < 1) return "agora";
  if (min < 60) return `há ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `há ${h} h`;
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}

export function Sininho({ membroId }: { membroId: string }) {
  const router = useRouter();
  const [avisos, setAvisos] = useState<Aviso[]>([]);
  const [aberto, setAberto] = useState(false);

  const carregar = useCallback(async () => {
    setAvisos(await listarMeusAvisos());
  }, []);

  useEffect(() => {
    void carregar();
    const relogio = setInterval(() => void carregar(), RELEITURA_MS);
    const aoVoltar = () => {
      if (document.visibilityState === "visible") void carregar();
    };
    document.addEventListener("visibilitychange", aoVoltar);
    return () => {
      clearInterval(relogio);
      document.removeEventListener("visibilitychange", aoVoltar);
    };
  }, [carregar]);

  useRealtimeChannel({
    name: `agencia-avisos-${membroId}`,
    postgresChanges: { event: "INSERT", schema: "public", table: "agencia_avisos", filter: `membro_id=eq.${membroId}` },
    onChange: () => {
      void carregar();
    },
  });

  const naoLidos = avisos.filter((a) => !a.lido_em).length;

  async function abrir(a: Aviso) {
    if (!a.lido_em) {
      await marcarAvisoComoLido(a.id);
      setAvisos((lista) => lista.map((x) => (x.id === a.id ? { ...x, lido_em: new Date().toISOString() } : x)));
    }
    setAberto(false);
    if (a.link) router.push(a.link);
  }

  async function marcarTodos() {
    const agora = new Date().toISOString();
    await marcarTodosComoLidos();
    setAvisos((lista) => lista.map((x) => (x.lido_em ? x : { ...x, lido_em: agora })));
  }

  return (
    <Popover open={aberto} onOpenChange={setAberto}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={naoLidos > 0 ? `Avisos: ${naoLidos} não lidos` : "Avisos"}
          data-testid="sininho-da-agencia"
          className="relative rounded-md p-2 text-muted-foreground hover:bg-accent/50 hover:text-foreground"
        >
          <Bell size={20} aria-hidden />
          {naoLidos > 0 && (
            <span
              data-testid="sininho-contador"
              className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-destructive-foreground"
            >
              {naoLidos > 9 ? "9+" : naoLidos}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(22rem,calc(100vw-2rem))] p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-sm font-semibold">Avisos</span>
          {naoLidos > 0 && (
            <button type="button" onClick={marcarTodos} className="text-xs text-muted-foreground hover:text-foreground">
              Marcar todos como lidos
            </button>
          )}
        </div>
        <ul className="max-h-96 overflow-y-auto">
          {avisos.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted-foreground">Nenhum aviso.</li>}
          {avisos.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                onClick={() => void abrir(a)}
                className={cn(
                  "flex w-full flex-col items-start gap-0.5 border-b px-3 py-2 text-left hover:bg-accent/50",
                  !a.lido_em && "bg-accent/30",
                )}
              >
                <span className={cn("text-sm", !a.lido_em && "font-semibold")}>{a.titulo}</span>
                {a.corpo && <span className="line-clamp-2 text-xs text-muted-foreground">{a.corpo}</span>}
                <span className="text-[11px] text-muted-foreground">{quando(a.criado_em)}</span>
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
