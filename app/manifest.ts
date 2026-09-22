import type { MetadataRoute } from "next";

/**
 * O MANIFESTO PWA — o "app do entregador" instalável.
 *
 * Não é um app nativo: é a operação instalável na tela inicial (Android:
 * "Adicionar à tela inicial" / iOS: "Adicionar à Tela de Início"), abrindo
 * em `standalone` (sem barra do navegador). O que funciona offline de
 * verdade é o FLUXO (outbox em `lib/entregas/outbox.ts` + última rota em
 * cache): abrir a URL do zero sem internet exige service worker, que é
 * fase futura — o cenário real (sinal cai no meio da rota, com a aba
 * aberta) já está coberto.
 *
 * Nome neutro de propósito: o manifest é estático e a marca varia por
 * instalação (doutrina white-label) — o ícone 512px carrega a marca,
 * porque ele é gerado em runtime (`app/icone-512/route.ts`).
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Operação de vendas",
    short_name: "Vendas",
    description: "Rotas de entrega com controle offline.",
    start_url: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#ffffff",
    icons: [
      { src: "/icon", sizes: "64x64", type: "image/png" },
      { src: "/icone-512", sizes: "512x512", type: "image/png", purpose: "any" },
    ],
  };
}
