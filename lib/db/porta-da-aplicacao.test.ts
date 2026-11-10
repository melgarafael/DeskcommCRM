import { describe, expect, it, vi } from "vitest";

// A porta do processo não pode abrir um pool PRÓPRIO: soma até DB_POOL_MAX
// conexões ao pool que o processo Next já tem (getRequestPool).
const pool = vi.hoisted(() => ({ query: vi.fn(async () => ({ rows: [{ id: 1 }] })) }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: vi.fn(() => pool) }));
vi.mock("@/lib/agent-engine/db/pool", () => ({ createPool: vi.fn(() => pool) }));

import { createPool } from "@/lib/agent-engine/db/pool";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { portaDaAplicacao } from "@/lib/db";

describe("portaDaAplicacao", () => {
  it("montar a porta não toca no pool; a consulta usa o pool que o processo já tem", async () => {
    const porta = portaDaAplicacao();
    expect(getRequestPool).not.toHaveBeenCalled();

    expect(await porta.query("select $1::int as id", [1])).toEqual([{ id: 1 }]);

    expect(getRequestPool).toHaveBeenCalled();
    expect(createPool).not.toHaveBeenCalled();
    expect(pool.query).toHaveBeenCalledWith("select $1::int as id", [1]);
  });
});
