import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";

import type { CatalogoDeExtensoes } from "./catalogo-extensoes";

const HOST = "127.0.0.1";
const PORT = 56331;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export interface CatalogoInterrompido {
  esperarDownloadPausado(): Promise<void>;
  downloadPausadoContinuaAberto(): boolean;
  liberarDownloadPausado(): void;
  esperarSocketInterrompido(): Promise<void>;
  estatisticas(): {
    bytesPausadosEnviados: number;
    downloadPausadoFinalizado: boolean;
    bytesInterrompidosEnviados: number;
    socketsInterrompidos: number;
  };
  encerrar(): Promise<void>;
}

/**
 * Receiver HTTP real da prova de recuperação. Ele assume a origem somente
 * depois que o processo Python próprio foi encerrado e serve exatamente os
 * bytes publicados pela fixture: um corpo fica pausado; o outro perde o socket.
 */
export async function iniciarCatalogoInterrompido(
  catalogo: CatalogoDeExtensoes,
): Promise<CatalogoInterrompido> {
  if (catalogo.estaLigado()) {
    throw new Error("Encerre o catálogo Python próprio antes de assumir a porta de ensaio.");
  }
  if (catalogo.origem !== `http://${HOST}:${PORT}`) {
    throw new Error("A origem do catálogo controlado não corresponde à porta E2E reservada.");
  }

  const downloadPausado = deferred();
  const liberarPausa = deferred();
  const socketInterrompido = deferred();
  const sockets = new Set<Socket>();
  let pausaLiberada = false;
  let respostaPausadaAberta = false;
  let bytesPausadosEnviados = 0;
  let downloadPausadoFinalizado = false;
  let bytesInterrompidosEnviados = 0;
  let socketsInterrompidos = 0;

  const server: Server = createServer((request, response) => {
    if (request.method !== "GET") {
      response.writeHead(405).end();
      return;
    }

    const path = new URL(request.url ?? "/", catalogo.origem).pathname;
    const pausedPath = `/packages/${catalogo.pacote.digest}.json`;
    const interruptedPath = `/packages/${catalogo.pacoteAlterado.digestAdmitido}.json`;

    if (path === pausedPath) {
      const bytes = catalogo.pacote.bytes;
      const split = Math.max(1, Math.floor(bytes.byteLength / 2));
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": String(bytes.byteLength),
        "Content-Encoding": "identity",
      });
      response.write(bytes.subarray(0, split));
      bytesPausadosEnviados = split;
      respostaPausadaAberta = true;
      downloadPausado.resolve();
      void liberarPausa.promise.then(() => {
        if (!response.destroyed) {
          response.end(bytes.subarray(split));
          downloadPausadoFinalizado = true;
        }
        respostaPausadaAberta = false;
      });
      return;
    }

    if (path === interruptedPath) {
      const bytes = catalogo.pacoteAlterado.bytes;
      const split = Math.max(1, Math.floor(bytes.byteLength / 2));
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": String(bytes.byteLength),
        "Content-Encoding": "identity",
      });
      response.write(bytes.subarray(0, split));
      bytesInterrompidosEnviados = split;
      setImmediate(() => {
        socketsInterrompidos += 1;
        response.destroy();
        socketInterrompido.resolve();
      });
      return;
    }

    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("not found");
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(PORT, HOST, () => {
      server.off("error", onError);
      const address = server.address() as AddressInfo | null;
      if (!address || address.address !== HOST || address.port !== PORT) {
        reject(new Error("O receiver de recuperação abriu endereço inesperado."));
        return;
      }
      resolve();
    });
  });

  return {
    esperarDownloadPausado: () => downloadPausado.promise,
    downloadPausadoContinuaAberto: () => respostaPausadaAberta && !pausaLiberada,
    liberarDownloadPausado() {
      if (pausaLiberada) return;
      pausaLiberada = true;
      liberarPausa.resolve();
    },
    esperarSocketInterrompido: () => socketInterrompido.promise,
    estatisticas: () => ({
      bytesPausadosEnviados,
      downloadPausadoFinalizado,
      bytesInterrompidosEnviados,
      socketsInterrompidos,
    }),
    async encerrar() {
      if (!pausaLiberada) {
        pausaLiberada = true;
        liberarPausa.resolve();
      }
      for (const socket of sockets) socket.destroy();
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
