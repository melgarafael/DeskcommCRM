-- manifest: o roteador ganha `passagem_ao_cliente` — o texto que avisa o CLIENTE de que a conversa trocou de agente automático (#4363). NULL = desligado, e o turno segue como hoje.
--
-- ─── O que faltava, e por que é COLUNA ─────────────────────────────────────
--
-- O #4385 já entrega a metade que avisa o AGENTE que herdou a conversa: um
-- bloco derivado do próprio turno (`lib/agent-engine/agent/passagem-do-roteador.ts`),
-- sem schema. A outra metade — a frase que o CLIENTE lê quando o roteador troca
-- quem atende — não tem de onde sair: ela é do dono do roteador, não do modelo.
-- Hoje o cliente só é avisado se o agente novo resolver se apresentar; nas
-- palavras do próprio #4385, o "aviso ao cliente é a primeira fala do agente novo".
--
-- Coluna em `ai_routers` (e não chave no `config` jsonb): o texto é editado na
-- tela do roteador, tem limite de tamanho que precisa ser CHECK (o `config` é
-- lido defensivamente, e um texto de 40 KB gravado por engano viraria mensagem
-- de WhatsApp truncada pelo adapter, sem erro nenhum no caminho). `ai_routers`
-- já tem trigger de auditoria, então quem trocou a frase fica registrado junto
-- com o resto da configuração do roteador.
--
-- ─── Desligado por PADRÃO, e o padrão é o comportamento atual ───────────────
--
-- NULL = nenhuma mensagem ao cliente: a troca continua silenciosa e é o agente
-- novo quem se apresenta (o que o #4385 já faz). Texto vazio depois do btrim
-- também NUNCA envia — o CHECK recusa gravar, e o leitor trata '' como NULL,
-- para que um PATCH antigo não vire mensagem em branco no WhatsApp do cliente.
--
-- ─── Por que 1200 ──────────────────────────────────────────────────────────
--
-- É o teto de mensagem que o produto já pratica em texto de agente; acima disso
-- o canal fatia a mensagem em bolhas e a "frase de passagem" deixa de ser uma
-- frase. O CHECK é a única guarda de tamanho: quem escreve pela API, pela tela
-- ou por SQL direto passa pela mesma régua.
--
-- ─── Nada de PII ───────────────────────────────────────────────────────────
--
-- É TEXTO DE CONFIGURAÇÃO, escrito pelo dono do roteador — não carrega dado do
-- contato e não entra em `ai_router_decisions` (que segue sem PII desde a 0085).
-- O preenchimento acontece no envio, e o corpo enviado não é logado.

alter table public.ai_routers
  add column if not exists passagem_ao_cliente text;

do $$ begin
  alter table public.ai_routers
    add constraint ai_routers_passagem_ao_cliente_tamanho
    check (
      passagem_ao_cliente is null
      or length(btrim(passagem_ao_cliente)) between 1 and 1200
    );
exception when duplicate_object then null; end $$;

comment on column public.ai_routers.passagem_ao_cliente is
  'Frase enviada ao CLIENTE, uma vez, quando o roteador troca de agente automaticamente (desfecho reclassified). NULL = desligado (comportamento de antes: o agente novo se apresenta). Escrita na tela do roteador, no idioma da organização. Não carrega PII e não entra em ai_router_decisions.';
