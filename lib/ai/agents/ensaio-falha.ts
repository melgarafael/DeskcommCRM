/**
 * Classificação da falha do ensaio. O toast e o `error_code` do run saem DAQUI,
 * nunca do `err.message` cru — aquele pode carregar chave, path ou stack.
 */
import {
  CODIGO_PLAYBOOK_PLATFORM_AUSENTE,
  PlaybookPlatformMissingError,
} from "@/lib/agent-engine/agent/playbook-ensure";

export { CODIGO_PLAYBOOK_PLATFORM_AUSENTE };

export const CODIGO_ENSAIO_FALHOU = "preview_failed";

export const MSG_PLAYBOOK_PLATFORM_AUSENTE =
  "Não foi possível preparar o playbook obrigatório do ensaio.";

export const MSG_ENSAIO_FALHOU = "Não foi possível executar o teste.";

export const STATUSES_DO_RUN = [
  "pending",
  "running",
  "completed",
  "failed",
  "aborted",
  "handoff",
] as const;

export type StatusDoRun = (typeof STATUSES_DO_RUN)[number];

export type FalhaClassificadaDoEnsaio = {
  code: typeof CODIGO_PLAYBOOK_PLATFORM_AUSENTE | typeof CODIGO_ENSAIO_FALHOU;
  message: string;
};

function textoDoErro(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function ehPlaybookPlatformAusente(err: unknown): boolean {
  if (err instanceof PlaybookPlatformMissingError) return true;
  if (typeof err === "object" && err !== null && "code" in err) {
    return (err as { code: unknown }).code === CODIGO_PLAYBOOK_PLATFORM_AUSENTE;
  }
  return textoDoErro(err).includes("ponteiro da camada plataforma ausente");
}

export function classificarFalhaDoEnsaio(err: unknown): FalhaClassificadaDoEnsaio {
  if (ehPlaybookPlatformAusente(err)) {
    return {
      code: CODIGO_PLAYBOOK_PLATFORM_AUSENTE,
      message: MSG_PLAYBOOK_PLATFORM_AUSENTE,
    };
  }
  return { code: CODIGO_ENSAIO_FALHOU, message: MSG_ENSAIO_FALHOU };
}
