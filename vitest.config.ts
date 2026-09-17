import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  // JSX automático já é o default do transform esbuild no Vite 7+ (vitest 4);
  // a opção `esbuild.jsx` saiu do tipo — provado pelos testes de componente.
  test: {
    environment: "jsdom",
    // O padrão do vitest é 5s por teste. Numa suíte jsdom + Testing Library
    // isso é apertado: em máquina carregada (CI concorrido, dev rodando outras
    // coisas) testes SAUDÁVEIS estouram e a suíte fica vermelha por lentidão.
    // Aconteceu três vezes aqui, em testes diferentes a cada vez — inclusive
    // derrubando a main num PR que só mexia em documentação. Um gate que
    // reprova sem defeito ensina o time a ignorar o gate.
    // 15s não mascara travamento (quem trava continua reprovando, dez segundos
    // depois); só para de cronometrar a lentidão da máquina como se fosse
    // asserção. Caso que precisa de mais (abrir processo filho) declara o seu.
    testTimeout: 15_000,
    setupFiles: ["./tests/setup/vitest.setup.ts"],
    globals: true,
    coverage: { provider: "v8", reporter: ["text", "html"] },
    // tests/journeys/** roda no Playwright (jornada de baseline dos canais), igual
    // a tests/e2e/**: sem excluir, o include default do vitest o pegaria e o
    // import de @playwright/test derrubaria a suíte unitária.
    exclude: [
      "**/node_modules/**",
      ".next",
      "dist",
      ".claude/**",
      "tests/e2e/**",
      "tests/invariants/**",
      "tests/journeys/**",
      // Bancada opcional: usa node:test, PostgreSQL próprio e Playwright com
      // configuração dedicada. Não depende do ambiente da suíte do produto.
      "experiments/extensoes/**",
    ],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
      // `server-only` não é dependência do projeto: o Next o resolve para o próprio módulo vazio
      // quando o código roda no servidor. Os testes rodam como servidor, então usam o mesmo vazio.
      "server-only": path.resolve(__dirname, "node_modules/next/dist/compiled/server-only/empty.js"),
    },
  },
});
