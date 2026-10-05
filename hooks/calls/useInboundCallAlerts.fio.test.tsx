/**
 * TESTE DO FIO DO ALERTA (recusada de bloqueado).
 *
 * Prova que o `onChange` do `useInboundCallAlerts` USA `deveAvisarChamadaEntrante`:
 * linha recusada (`ended` + `contact_blocked`) não chama `entregarAviso`;
 * linha `ringing` normal chama. Precedente: `useEtapasDeGatilho.test.tsx`
 * (renderHook) e `InterfaceRefresh.test.tsx` (mock de `useRealtimeChannel`).
 *
 * SABOTAGEM: voltar o `onChange` para os dois checks antigos (sem a guarda)
 * = caso "recusada" vermelho (avisa quando não devia).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

const fakes = vi.hoisted(() => ({
  onChange: null as null | ((payload: unknown) => void),
  avisos: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/hooks/realtime/useRealtimeChannel", () => ({
  useRealtimeChannel: (cfg: { onChange?: (payload: unknown) => void }) => {
    fakes.onChange = cfg.onChange ?? null;
  },
}));

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => ({ orgId: "org-do-fio-alerta" }),
  usePermission: () => true,
}));

vi.mock("@/lib/notifications/prefs", () => ({
  canalLigado: () => true,
}));

vi.mock("@/lib/notifications/deliver", () => ({
  entregarAviso: (aviso: Record<string, unknown>) => {
    fakes.avisos.push(aviso);
  },
}));

vi.mock("@/lib/supabase/browser", () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: null }) }),
      }),
    }),
  }),
}));

import { useInboundCallAlerts } from "./useInboundCallAlerts";

const linha = (campos: Record<string, unknown>) => ({ new: { provider: "sip", ...campos } });

async function descarregar() {
  await new Promise((r) => setTimeout(r, 20));
}

describe("fio do alerta de chamada entrante", () => {
  beforeEach(() => {
    fakes.avisos = [];
    renderHook(() => useInboundCallAlerts());
    if (!fakes.onChange) throw new Error("onChange não capturado");
  });

  it("recusada de bloqueado não avisa", async () => {
    fakes.onChange!({
      new: {
        provider: "sip",
        direction: "inbound",
        status: "ended",
        end_reason: "contact_blocked",
        peer_phone: "+5511999999999",
        contact_id: "contato-bloq",
        id: "chamada-1",
      },
    });
    await descarregar();
    expect(fakes.avisos).toHaveLength(0);
  });

  it("ringing normal avisa", async () => {
    fakes.onChange!(
      linha({
        direction: "inbound",
        status: "ringing",
        peer_phone: "+5511999999999",
        contact_id: null,
        id: "chamada-2",
      }),
    );
    await waitFor(() => expect(fakes.avisos).toHaveLength(1));
  });
});
