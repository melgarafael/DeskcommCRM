"use client";

import { toast } from "sonner";

/**
 * Toasts padronizados. Centraliza texto e duração para não espalhar
 * `toast.success` com estilos diferentes por página.
 */
export const nexusToast = {
  success(message: string, description?: string) {
    toast.success(message, description ? { description } : undefined);
  },
  error(message: string, description?: string) {
    toast.error(message, description ? { description } : undefined);
  },
  info(message: string, description?: string) {
    toast.info(message, description ? { description } : undefined);
  },
};
