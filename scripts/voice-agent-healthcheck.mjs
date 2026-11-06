// Prova apenas a porta AudioSocket do processo, sem frame de chamada, ARI ou banco.
import { createConnection } from "node:net";

const portaBruta = process.env.AUDIOSOCKET_PORT ?? "9092";
const porta = Number(portaBruta);
if (!/^\d+$/.test(portaBruta) || !Number.isInteger(porta) || porta < 1 || porta > 65535) {
  process.exit(1);
}

let socket;
let encerrado = false;
// Menor que o timeout do Docker: o próprio probe fecha a conexão pendente.
const prazo = setTimeout(() => encerrar(1), 3000);

function encerrar(codigo) {
  if (encerrado) return;
  encerrado = true;
  clearTimeout(prazo);
  socket?.destroy();
  process.exitCode = codigo;
}

socket = createConnection({ host: "127.0.0.1", port: porta });
socket.once("connect", () => encerrar(0));
socket.once("error", () => encerrar(1));
