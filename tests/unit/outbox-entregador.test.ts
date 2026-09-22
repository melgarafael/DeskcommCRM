import { describe, expect, it } from "vitest";

import {
  carregarOutbox,
  descarregarOutbox,
  enfileirarDesfecho,
  lerRotaLocal,
  mapaPendentes,
  removerDesfecho,
  salvarRotaLocal,
  type ArmazenLocal,
  type DesfechoPendente,
} from "@/lib/entregas/outbox";

function bolsa(): ArmazenLocal {
  const mapa = new Map<string, string>();
  return {
    getItem: (c) => mapa.get(c) ?? null,
    setItem: (c, v) => {
      mapa.set(c, v);
    },
  };
}

const BASE = {
  cargaId: "carga-1",
  orderId: "ped-1",
  status: "entregue" as const,
  ocorrido_em: new Date().toISOString(),
};

describe("outbox do entregador", () => {
  it("enfileira e lista; remarcar o mesmo pedido substitui", () => {
    const s = bolsa();
    enfileirarDesfecho(BASE, s);
    enfileirarDesfecho({ ...BASE, status: "devolvido", motivo: "recusado" }, s);
    const lista = carregarOutbox(s);
    expect(lista).toHaveLength(1);
    expect(lista[0]?.status).toBe("devolvido");
    expect(lista[0]?.id).toBeTruthy();
  });

  it("mapaPendentes pinta a lista antes do servidor saber", () => {
    const s = bolsa();
    enfileirarDesfecho(BASE, s);
    expect(mapaPendentes("carga-1", s).get("ped-1")?.status).toBe("entregue");
    expect(mapaPendentes("outra-carga", s).size).toBe(0);
  });

  it("descarga envia em ordem e mantém só as falhas", async () => {
    const s = bolsa();
    enfileirarDesfecho({ ...BASE, orderId: "a" }, s);
    enfileirarDesfecho({ ...BASE, orderId: "b" }, s);
    const ordem: string[] = [];
    const r = await descarregarOutbox(async (item: DesfechoPendente) => {
      ordem.push(item.orderId);
      if (item.orderId === "b") throw new Error("sem sinal");
    }, s);
    expect(r.enviados).toBe(1);
    expect(r.falhas).toHaveLength(1);
    expect(ordem).toEqual(["a", "b"]);
    const resto = carregarOutbox(s);
    expect(resto).toHaveLength(1);
    expect(resto[0]?.orderId).toBe("b");
    expect(resto[0]?.tentativas).toBe(1);
  });

  it("removerDesfecho tira da fila", () => {
    const s = bolsa();
    const item = enfileirarDesfecho(BASE, s);
    removerDesfecho(item.id, s);
    expect(carregarOutbox(s)).toHaveLength(0);
  });

  it("rota local salva e lê; sem nada devolve null", () => {
    const s = bolsa();
    expect(lerRotaLocal("x", s)).toBeNull();
    salvarRotaLocal("x", { paradas: [1, 2] }, s);
    expect(lerRotaLocal<{ paradas: number[] }>("x", s)).toEqual({ paradas: [1, 2] });
  });
});
