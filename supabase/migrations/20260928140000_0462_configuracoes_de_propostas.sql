-- ---- configuracoes de propostas (migration 0462) ----
-- A capacidade nasce DESLIGADA: atualizar nao muda nada em organizacao
-- nenhuma ate alguem ligar a regra (mesmo criterio do PR "Clientes pela
-- agenda" — ver CHANGELOG 1.28.0).
-- organizations.settings e jsonb COMPARTILHADO (branding, security moram
-- nele) — este bloco so ACRESCENTA a chave 'proposals', nunca sobrescreve
-- settings inteiro.
update public.organizations
set settings = jsonb_set(
  coalesce(settings, '{}'::jsonb),
  '{proposals}',
  '{"enabled": false, "default_valid_days": 15, "default_conditions": null}'::jsonb,
  true
)
where settings->'proposals' is null;
