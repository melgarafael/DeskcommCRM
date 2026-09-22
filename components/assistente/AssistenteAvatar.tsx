"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createAvatar, type AvatarController } from "@bible-strong/avatar-react";
import { cn } from "@/lib/utils";
import definition from "./strobi.avatar.json";
import { olharPara } from "./olhares";

/**
 * O Strobi — avatar oficial exportado no Avatar Lab — como rosto do ajudante.
 *
 * A definição (`strobi.avatar.json`) é DADO versionado no repo: nada é baixado
 * de `avatars.bible-strong.app` em runtime, então funciona offline e no
 * self-host. Para trocar de avatar, exporte outro `.avatar.json` no Lab e
 * sobrescreva este arquivo — `strobi.test.ts` e `olhares.test.ts` quebram se
 * as animações e expressões usadas abaixo sumirem. Ver
 * `public/assistente/README.md`.
 *
 * Reações (modo `defaultAnimation="idle"`, não-controlado):
 * - cursor: o olhar vira para a DIREÇÃO do mouse — vizinho mais próximo por
 *   ângulo entre 11 expressões (`olhares.ts`) — e o botão inclina junto;
 *   parado 2,5s, volta ao `idle`. Só troca quando a expressão muda, sem spam;
 * - chat aberto: `listening`; chat fechado: `idle`;
 * - clique: PISCA na hora (`eyes-closed`), sorri (`happy` ~1,5s) e faz
 *   "squash" no botão — a abertura do chat é decidida pelo pai via `onToggle`,
 *   aqui é só o charme;
 * - `prefers-reduced-motion` ou ponteiro grosso: Strobi estático (`neutral`),
 *   sem olhar que segue nem trocas — só o botão, parado.
 *
 * Detalhe da lib que este componente respeita: cada `setExpression` encerra a
 * timeline (`idle`) e, após a transição de 420ms, o avatar CONGELA na pose
 * (lido no fonte de `@bible-strong/avatar-react`). Por isso o olhar só mexe
 * quando a direção muda de verdade, e o `idle` é religado em toda volta —
 * sem isso, o primeiro movimento travava o Strobi olhando para um lado só.
 *
 * Se a lib recusar a definição em runtime (`onError`), cai para um SVG
 * estático simples em vez de quebrar a página.
 */

interface AssistenteAvatarProps {
  aberto: boolean;
  onToggle: () => void;
}

const StrobiAvatar = createAvatar(definition);

const INCLINACAO_MAX = 7;
/** Mouse parado por este tempo: solta o olhar e volta ao `idle` (vivo). */
const VOLTA_AO_IDLE_MS = 5000;
const ALEGRIA_DO_CLIQUE_MS = 1800;
/** Troca de olhar no máximo nesta cadência — a transição da lib leva 420ms. */
const OLHAR_MIN_MS = 150;

export function AssistenteAvatar({ aberto, onToggle }: AssistenteAvatarProps) {
  const botaoRef = useRef<HTMLButtonElement>(null);
  const controleRef = useRef<AvatarController>(null);
  /** A expressão de olhar atual; `null` = centro, `idle` religado. */
  const olharRef = useRef<string | null>(null);
  const ultimoOlharRef = useRef(0);
  const cliqueTokenRef = useRef(0);
  const abertoRef = useRef(aberto);
  const rafRef = useRef(0);
  const voltaTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [inclinacao, setInclinacao] = useState(0);
  const [pulando, setPulando] = useState(false);
  const [piscando, setPiscando] = useState(false);
  const [mostrarDica, setMostrarDica] = useState(false);
  const [falhou, setFalhou] = useState(false);
  const [calmo] = useState(
    () =>
      typeof window !== "undefined" &&
      (window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
        window.matchMedia("(pointer: coarse)").matches),
  );

  // Espelho para os timeouts lerem o valor atual sem recriar callbacks.
  useEffect(() => {
    abertoRef.current = aberto;
  }, [aberto]);

  const comandar = useCallback((cmd: (c: AvatarController) => void) => {
    try {
      const c = controleRef.current;
      if (c) cmd(c);
    } catch {
      // Comando recusado no meio da sessão: o Strobi segue no estado atual,
      // sem ruído no console (console.log é proibido neste repo).
    }
  }, []);

  // Chat aberto = ouvindo; fechado = repouso. Zera o olhar porque a
  // timeline assume — o próximo movimento recalcula do zero.
  useEffect(() => {
    if (calmo) return;
    olharRef.current = null;
    comandar((c) => {
      c.play(aberto ? "listening" : "idle");
    });
  }, [aberto, calmo, comandar]);

  // Dica "Precisa de ajuda?" aparece uma vez, 2s após montar, e some no
  // primeiro clique ou após 8s — sem storage, sem rastreio.
  useEffect(() => {
    const mostrar = setTimeout(() => setMostrarDica(true), 2000);
    const esconder = setTimeout(() => setMostrarDica(false), 10000);
    return () => {
      clearTimeout(mostrar);
      clearTimeout(esconder);
    };
  }, []);

  // Olhar segue o mouse por ÂNGULO (ver `olhares.ts`): só comanda quando a
  // expressão muda — e no máximo a cada 150ms — porque cada `setExpression`
  // congela a timeline e transitions sobrepostas viram tremedeira. O botão
  // inclina junto. Sem movimento por 5s, volta ao `idle`.
  useEffect(() => {
    if (typeof window === "undefined" || calmo) return;
    const agendarVolta = () => {
      if (voltaTimerRef.current) clearTimeout(voltaTimerRef.current);
      voltaTimerRef.current = setTimeout(() => {
        olharRef.current = null;
        comandar((c) => {
          c.play("idle");
        });
      }, VOLTA_AO_IDLE_MS);
    };
    const aoMover = (e: MouseEvent) => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        const el = botaoRef.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        const dx = e.clientX - (r.left + r.width / 2);
        const dy = e.clientY - (r.top + r.height / 2);
        const dist = Math.hypot(dx, dy) || 1;
        const agora = performance.now();
        const olhar = olharPara(dx, dy);
        if (olhar !== olharRef.current && agora - ultimoOlharRef.current >= OLHAR_MIN_MS) {
          olharRef.current = olhar;
          ultimoOlharRef.current = agora;
          comandar((c) => {
            if (olhar === null) c.play("idle");
            else c.setExpression(olhar);
          });
        }
        const força = Math.min(1, dist / 320);
        setInclinacao(
          Math.max(-INCLINACAO_MAX, Math.min(INCLINACAO_MAX, (dx / dist) * INCLINACAO_MAX * força)),
        );
        agendarVolta();
      });
    };
    window.addEventListener("mousemove", aoMover, { passive: true });
    return () => {
      window.removeEventListener("mousemove", aoMover);
      cancelAnimationFrame(rafRef.current);
      if (voltaTimerRef.current) clearTimeout(voltaTimerRef.current);
    };
  }, [calmo, comandar]);

  const clicar = useCallback(() => {
    setMostrarDica(false);
    if (!calmo) {
      // Token anti-sobreposição: cliques rápidos não embaralham a coreografia.
      const token = ++cliqueTokenRef.current;
      olharRef.current = null;
      // 1) PISCA NA HORA, em duas camadas: o squash CSS de 160ms (o que o
      // olho registra como piscada — a transição da lib leva 420ms, devagar
      // demais sozinha) + `eyes-closed` de verdade por baixo. Sem o CSS, era
      // uma piscada sonolenta de ~1s; sem a expressão, um flinch sem fechar.
      setPiscando(true);
      setTimeout(() => {
        if (cliqueTokenRef.current !== token) return;
        setPiscando(false);
      }, 180);
      comandar((c) => {
        c.setExpression("eyes-closed");
      });
      setPulando(true);
      setTimeout(() => setPulando(false), 380);
      // 2) reabre e sorri.
      setTimeout(() => {
        if (cliqueTokenRef.current !== token) return;
        comandar((c) => {
          c.play("happy");
        });
      }, 200);
      // 3) a alegria é curta: volta ao estado do chat (ouvindo/aberto ou
      // repouso/fechado) em vez de travar no `happy`.
      setTimeout(() => {
        if (cliqueTokenRef.current !== token) return;
        comandar((c) => {
          c.play(abertoRef.current ? "listening" : "idle");
        });
      }, ALEGRIA_DO_CLIQUE_MS);
    }
    onToggle();
  }, [calmo, comandar, onToggle]);

  return (
    <div className="relative">
      {mostrarDica && !aberto && (
        <div
          role="status"
          className="absolute -top-11 right-0 w-max max-w-55 rounded-xl border border-border bg-background px-3 py-1.5 text-xs font-medium text-text shadow-lg"
        >
          Precisa de ajuda? Clique em mim!
          <span className="absolute -bottom-1 right-8 h-2 w-2 rotate-45 border-r border-b border-border bg-background" />
        </div>
      )}
      <button
        ref={botaoRef}
        type="button"
        onClick={clicar}
        aria-label={aberto ? "Fechar ajuda" : "Abrir ajuda"}
        aria-expanded={aberto}
        title={aberto ? "Fechar ajuda" : "Abrir ajuda"}
        className={cn(
          "group grid h-20 w-20 place-items-center overflow-hidden rounded-full border-2 border-border bg-background shadow-xl transition-transform duration-150 hover:scale-105 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent active:scale-95",
          pulando && "animate-[assistente-pulo_0.38s_ease]",
          aberto && "ring-2 ring-accent ring-offset-2",
        )}
        style={{ transform: `rotate(${inclinacao}deg)` }}
      >
        {falhou ? (
          <svg viewBox="0 0 64 64" className="h-16 w-16" aria-hidden="true">
            <ellipse cx="32" cy="36" rx="22" ry="20" className="fill-accent" />
            <ellipse cx="24.5" cy="32" rx="5" ry="6" className="fill-white" />
            <ellipse cx="39.5" cy="32" rx="5" ry="6" className="fill-white" />
            <circle cx="24.5" cy="32" r="2.6" className="fill-slate-900" />
            <circle cx="39.5" cy="32" r="2.6" className="fill-slate-900" />
            <path d="M26 44 Q32 49 38 44" stroke="#fff" strokeWidth="2.4" fill="none" strokeLinecap="round" />
          </svg>
        ) : (
          // O span é o que pisca (squash vertical de 160ms): animar o botão
          // mexeria no anel de foco e no tilt, que moram nele.
          <span
            className={cn("grid place-items-center", piscando && "animate-[assistente-pisca_0.16s_ease]")}
          >
            {calmo ? (
              <StrobiAvatar
                ref={controleRef}
                defaultExpression="neutral"
                autoplay={false}
                size={68}
                ariaLabel="Assistente de ajuda"
                onError={() => setFalhou(true)}
              />
            ) : (
              <StrobiAvatar
                ref={controleRef}
                defaultAnimation="idle"
                size={68}
                ariaLabel="Assistente de ajuda"
                onError={() => setFalhou(true)}
              />
            )}
          </span>
        )}
        <span className="absolute -right-0.5 -top-0.5 flex h-4 w-4">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
          <span className="relative inline-flex h-4 w-4 rounded-full border-2 border-background bg-emerald-400" />
        </span>
      </button>
    </div>
  );
}
