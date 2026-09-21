# Instagram — criação, referências e resultados

Rotas: `/app/instagram`, `/new`, `/library`, `/posts/[id]`, `/inspirations`, `/insights` dentro de Instagram. Prospecção mantém `/app/prospecting`, agora com a entrada **Conquiste novos clientes**.

O cliente descreve nicho, ideia e formato; o servidor usa GPT Image 2.5 Flare e cria legenda. O pedido é persistido antes da chamada externa e seu UUID impede repetição. Imagens privadas usam URLs assinadas com validade de uma hora. Nada publica automaticamente. A revisão permite salvar legenda, copiar e baixar.

Referências são perfis informados pelo usuário. Pesquisa usa busca web com citações; sem fonte verificável, falha explicitamente. Não segue pessoas, não envia mensagens, não garante acesso a todos os posts nem afirma viralidade sem evidência. “Adaptar para meu negócio” preenche uma nova criação, sem publicar.

Resultados usam a conexão social já existente, via adapter em `lib/channels/social/instagram-insights.ts`. A conta é validada contra o perfil da organização antes de consultar métricas. Ausência de métrica aparece como indisponível, nunca zero. A integração atual requer análise habilitada no provedor; não se apresenta como uma nova integração direta com a Meta.

Backend: `/api/v1/instagram` lista e cria; `/:id` consulta, edita legenda e remove somente referências; `/insights` consulta contas e métricas. Viewer lê; agent cria e edita; configurações de canais preservam admin. O modo de suporte é respeitado.

Dados: `instagram_studio_items`, isolada por organização, RLS para leitura, mutações somente por backend com guarda. A migration 0321 acompanha baseline e MANIFEST. Ações `instagram.*` alimentam auditoria. Falhas ficam no histórico para recuperação; pedidos interrompidos há mais de dez minutos são apresentados como falha, sem reenvio automático.

Credencial central existente `OPENAI_API_KEY`, nunca enviada ao navegador. Consumo usa reservas da assinatura. Imagem mede tokens reais com a tarifa publicada do modelo. Texto e pesquisa usam GPT 5.6 Luna, medem tokens, cache e tier retornados, e acrescentam a tarifa da busca web por chamada concluída. Quando faltam medições, a reserva fica para conciliação, sem declarar consumo gratuito. Limite adicional de 20 pedidos por organização por dia.

Fontes consultadas em 20/09/2026: https://developers.openai.com/api/docs/models/gpt-image-2.5-flare e https://docs.zernio.com/analytics/get-instagram-account-insights.mdx.
