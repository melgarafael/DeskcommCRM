'use client';
import { OrganizationTransitionProvider } from '@/components/shell/OrganizationTransitionProvider';
import { QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { useState, type ReactNode } from 'react';
import { makeQueryClient } from '@/lib/query/client';
// Efeito de módulo: captura o pedido de instalação do navegador em qualquer
// tela, inclusive no /login, antes de a pessoa chegar à tela de instalar.
import '@/lib/pwa/pedido-de-instalacao';

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => makeQueryClient());
  return (
    <OrganizationTransitionProvider>
    <QueryClientProvider client={queryClient}>
      {children}
      {process.env.NODE_ENV === 'development' && <ReactQueryDevtools initialIsOpen={false} />}
    </QueryClientProvider>
    </OrganizationTransitionProvider>
  );
}
