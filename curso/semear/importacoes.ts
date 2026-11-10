/**
 * Mesma semente de "Empresas" (curso/semear/empresas.ts): as telas de Empresas,
 * Pessoas e Importações leem as mesmas tabelas. Só o `semear` é reexportado — o
 * `limpar` mora num lugar só, e a base o chama uma vez.
 */
export { semear } from "./empresas";
