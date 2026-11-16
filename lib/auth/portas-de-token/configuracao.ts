/**
 * PORTAS DE TOKEN — CONFIGURAÇÃO (Spec 33, fatia R1).
 *
 * Rotas de configuração. O token precisa de `config:read`/`config:write` e de papel admin (`tokenRole`, precedentes #2194 e #2824); a sessão continua com o papel de sempre.
 */
import type { ModeloDePorta } from "./porta";

// Cada modelo é o caminho de uma pasta de `app/` cuja `route.ts` chama
// `resolveAuthDual` em pelo menos um método. Método que continua só de sessão
// na mesma rota segue recusando o token com 401 no `requireRole`, porque o
// proxy filtra por caminho e não por método. A cerca
// `tests/unit/rotas-bearer-tem-porta-no-proxy.test.ts` reprova porta sem rota
// com token e rota com token sem porta.
export const MODELOS_DA_CONFIGURACAO: readonly ModeloDePorta[] = [];
