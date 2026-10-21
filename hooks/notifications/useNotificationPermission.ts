"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import { emitNotification } from "@/lib/notifications/emit";
import {
  areAlertsEnabled,
  assinarPermissao,
  getPermission,
  requestPermission,
  setAlertsEnabled,
  type NotificationPermissionState,
} from "@/lib/notifications/permission";
import { encerrarPushDesteAparelho, syncPushSubscription } from "@/lib/notifications/push_client";
import { ensureNotifyServiceWorker } from "@/lib/notifications/service_worker";
import { resumeAudio } from "@/lib/notifications/sounds";

function confirmOnOs(on: boolean): void {
  emitNotification({
    kind: "alerts_toggle",
    title: on ? "Alertas ligados" : "Alertas desligados",
    body: on
      ? "Novas mensagens aparecem na bandeja do sistema."
      : "Este navegador não vai mais avisar na bandeja.",
    force: true,
    sound: on ? "success" : "failure",
  });
}

function permissaoNoServidor(): NotificationPermissionState {
  return "unsupported";
}

export function useNotificationPermission(): {
  permission: NotificationPermissionState;
  enabled: boolean;
  request: () => Promise<NotificationPermissionState>;
  setEnabled: (on: boolean) => void;
} {
  /**
   * ⚠️ LIDA NO RENDER, NÃO NUM EFEITO — e isso conserta uma tela, não um teste.
   *
   * Isto era `useState("default")` + `useEffect(() => setPermission(...))`, e o
   * `"default"` é um CHUTE: ele significa "o navegador ainda não perguntou",
   * que é uma das três respostas possíveis, escolhida antes de olhar. Como
   * `denied` desabilita o interruptor de Push em `_client.tsx`, a sequência era:
   *
   *   1. primeiro render → `"default"` → interruptor HABILITADO;
   *   2. o efeito roda DEPOIS do paint, lê `denied`, e ele desabilita sozinho.
   *
   * Quem tem a notificação bloqueada no navegador via, por um instante, um
   * controle pronto para uso que sumia na frente dele — e um clique naquela
   * janela ia parar num `request()` que já estava decidido.
   *
   * `useSyncExternalStore` lê o valor no PRÓPRIO render, sem chute e sem
   * janela. O snapshot do SERVIDOR é a constante `"unsupported"` — a verdade
   * do servidor, que não tem `Notification` — e NÃO `getPermission`: o React
   * chama esse snapshot também NO CLIENTE, durante a hidratação, para bater
   * com o HTML. Com `getPermission` ali, o cliente hidratava com o valor real
   * (`"granted"`) contra um HTML `"unsupported"`, e o React não corrige atributo
   * divergente: os interruptores de Push ficavam `disabled` para sempre, e com
   * `"denied"` o parágrafo de bloqueio dava o erro #418 a cada carga
   * (`_client.hidratacao.test.tsx`). Com a constante, a hidratação bate e o
   * React re-renderiza logo depois com o valor real. O único flash que sobra é
   * o seguro, de desabilitado para habilitado, que nunca oferece o que talvez
   * não funcione.
   *
   * O custo dessa janela não foi teórico: ela deixou
   * `tests/e2e/notificacoes-diz-o-que-falta.spec.ts` passando por SORTE, e o
   * primeiro PR a mudar o timing o bastante para perder a corrida ficou vermelho
   * sem ter quebrado nada.
   */
  const permission = useSyncExternalStore(assinarPermissao, getPermission, permissaoNoServidor);
  const [enabled, setEnabledState] = useState(false);

  useEffect(() => {
    setEnabledState(areAlertsEnabled());
  }, []);

  const request = useCallback(async () => {
    await resumeAudio();
    const next = await requestPermission();
    if (next === "granted") {
      setAlertsEnabled(true);
      setEnabledState(true);
      void ensureNotifyServiceWorker().then(() => syncPushSubscription());
      confirmOnOs(true);
    }
    return next;
  }, []);

  const setEnabled = useCallback((on: boolean) => {
    setAlertsEnabled(on);
    setEnabledState(on);
    if (on) {
      void resumeAudio();
      void ensureNotifyServiceWorker().then(() => syncPushSubscription());
    } else {
      void encerrarPushDesteAparelho();
    }
    confirmOnOs(on);
  }, []);

  return { permission, enabled, request, setEnabled };
}
