export interface BlingFeatures {
  sync_contacts: boolean;
  sync_products: boolean;
  ai_stock_consult: boolean;
  auto_create_order: boolean;
  invoice_emission: boolean;
  tracking_notifications: boolean;
  financial_bills: boolean;
  ai_fiscal_agent: boolean;
}

export const DEFAULT_BLING_FEATURES: BlingFeatures = {
  sync_contacts: false,
  sync_products: false,
  ai_stock_consult: false,
  auto_create_order: false,
  invoice_emission: false,
  tracking_notifications: false,
  financial_bills: false,
  ai_fiscal_agent: false,
};

export type BlingIntegrationStatus = 'disconnected' | 'connected' | 'error';

export interface BlingIntegrationConfig {
  id: string;
  organization_id: string;
  is_enabled: boolean;
  client_id: string | null;
  status: BlingIntegrationStatus;
  features: BlingFeatures;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BlingSyncLog {
  id: string;
  organization_id: string;
  operation: string;
  direction: 'outbound' | 'inbound_webhook';
  status: 'success' | 'failed' | 'pending';
  details: Record<string, unknown>;
  error_message: string | null;
  created_at: string;
}
