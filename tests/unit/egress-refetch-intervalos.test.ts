import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Intervalos de refetch e guardas contra consumo excessivo de egress (#2235)", () => {
  it("UpdatePanel não usa mais refetchInterval fixo incondicional de 5s", () => {
    const conteudo = fs.readFileSync(
      path.resolve(process.cwd(), "app/app/settings/atualizacao/_components/UpdatePanel.tsx"),
      "utf8",
    );

    // Não deve ter `{ refetchInterval: 5_000 }` incondicional
    expect(conteudo).not.toMatch(/useSystemVersion\(\s*\{\s*refetchInterval:\s*5_?000\s*\}\s*\)/);

    // Deve verificar se o run está despachado antes de acelerar para 5s
    expect(conteudo).toMatch(/status === ["']dispatched["']/);
  });

  it("backup.sh avisa sobre o egress sem tirar o backup diário do padrão", () => {
    const conteudo = fs.readFileSync(
      path.resolve(process.cwd(), "hostgator-setup-kit/backup.sh"),
      "utf8",
    );

    expect(conteudo).toMatch(/egress/i);
    expect(conteudo).toMatch(/Shared Pooler/);
    // O cron recomendado continua diário (decisão do mantenedor no #4803).
    expect(conteudo).toMatch(/crontab -e →\s+0 3 \* \* \*\s/);
  });
});
