import { QueryClient } from '@tanstack/react-query';

export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: false,
        /**
         * UMA ESCADA SÓ — e ela mora no cliente HTTP.
         *
         * ─── O que havia aqui, medido ────────────────────────────────────────
         *
         * Esta camada repetia 429/503 até duas vezes por conta própria, e o
         * `apiClient` já repetia os MESMOS status até três vezes (com teto,
         * espera crescente e `Retry-After`). Como as duas escadas se compõem,
         * uma única listagem do Inbox contra um servidor saturado virava
         * 9 requisições (3 x 3), cada uma com o timeout de 10 s: até ~90 s de
         * esqueleto na tela — o sintoma exato da issue #4508 ("demora
         * excessivamente... permanece exibindo o skeleton").
         *
         * Repetir aqui não acrescenta informação nenhuma: quando a resposta
         * chega nesta camada como `ApiError`, o cliente HTTP já gastou as três
         * tentativas dele. O que a segunda escada fazia era multiplicar o
         * pedido, e contra um servidor que já está fora, mais pedido é pior.
         *
         * ─── O que continua valendo ─────────────────────────────────────────
         *
         * O TETO e a ESPERA não sumiram: ficaram onde a decisão de repetir já
         * sabe distinguir transporte de contrato (`lib/api/retentativa.ts`).
         * Erro de contrato nunca se repete em camada nenhuma — nem aqui, nem
         * lá — porque repetir um pedido inválido só multiplica o erro.
         *
         * Quem quiser repetir de novo depois disso é a PESSOA: o botão
         * "Tentar novamente" da tela (`ConversationList`), com o motivo na
         * frente dela.
         */
        retry: false,
      },
      mutations: { retry: false },
    },
  });
}
