export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      agent_inbox_items: {
        Row: {
          body: string | null
          created_at: string
          id: string
          kind: string
          organization_id: string | null
          ref_id: string | null
          ref_kind: string | null
          severity: string
          status: string
          title: string
        }
        Insert: {
          body?: string | null
          created_at?: string
          id?: string
          kind: string
          organization_id?: string | null
          ref_id?: string | null
          ref_kind?: string | null
          severity?: string
          status?: string
          title: string
        }
        Update: {
          body?: string | null
          created_at?: string
          id?: string
          kind?: string
          organization_id?: string | null
          ref_id?: string | null
          ref_kind?: string | null
          severity?: string
          status?: string
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_inbox_items_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_agent_runs: {
        Row: {
          abort_reason: string | null
          agent_id: string
          agent_version_id: string
          channel_session_id: string | null
          completed_at: string | null
          contact_id: string | null
          conversation_id: string | null
          cost_cents: number
          created_at: string
          error_code: string | null
          error_message: string | null
          id: string
          inbound_message_id: string | null
          is_dry_run: boolean
          latency_ms: number | null
          organization_id: string
          outbound_message_id: string | null
          started_at: string
          status: string
          steps_count: number
          tokens_in: number
          tokens_out: number
          tool_calls: Json
        }
        Insert: {
          abort_reason?: string | null
          agent_id: string
          agent_version_id: string
          channel_session_id?: string | null
          completed_at?: string | null
          contact_id?: string | null
          conversation_id?: string | null
          cost_cents?: number
          created_at?: string
          error_code?: string | null
          error_message?: string | null
          id?: string
          inbound_message_id?: string | null
          is_dry_run?: boolean
          latency_ms?: number | null
          organization_id: string
          outbound_message_id?: string | null
          started_at?: string
          status?: string
          steps_count?: number
          tokens_in?: number
          tokens_out?: number
          tool_calls?: Json
        }
        Update: {
          abort_reason?: string | null
          agent_id?: string
          agent_version_id?: string
          channel_session_id?: string | null
          completed_at?: string | null
          contact_id?: string | null
          conversation_id?: string | null
          cost_cents?: number
          created_at?: string
          error_code?: string | null
          error_message?: string | null
          id?: string
          inbound_message_id?: string | null
          is_dry_run?: boolean
          latency_ms?: number | null
          organization_id?: string
          outbound_message_id?: string | null
          started_at?: string
          status?: string
          steps_count?: number
          tokens_in?: number
          tokens_out?: number
          tool_calls?: Json
        }
        Relationships: [
          {
            foreignKeyName: "ai_agent_runs_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "ai_agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_agent_runs_agent_version_id_fkey"
            columns: ["agent_version_id"]
            isOneToOne: false
            referencedRelation: "ai_agent_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_agent_runs_channel_session_id_fkey"
            columns: ["channel_session_id"]
            isOneToOne: false
            referencedRelation: "channel_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_agent_runs_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_agent_runs_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_agent_runs_inbound_message_id_fkey"
            columns: ["inbound_message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_agent_runs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_agent_runs_outbound_message_id_fkey"
            columns: ["outbound_message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_agent_versions: {
        Row: {
          agent_id: string
          channel_session_id: string
          cost_budget_cents: number
          created_at: string
          created_by: string | null
          credential_id: string | null
          handoff_keywords: string[]
          handoff_tool_enabled: boolean
          history_message_window: number
          history_token_window: number
          id: string
          max_steps: number
          model: string
          organization_id: string
          provider: string
          published_at: string | null
          status: string
          superseded_at: string | null
          system_prompt: string
          token_budget: number
          tool_ids: string[]
          trigger_config: Json
          version_number: number
        }
        Insert: {
          agent_id: string
          channel_session_id: string
          cost_budget_cents?: number
          created_at?: string
          created_by?: string | null
          credential_id?: string | null
          handoff_keywords?: string[]
          handoff_tool_enabled?: boolean
          history_message_window?: number
          history_token_window?: number
          id?: string
          max_steps?: number
          model: string
          organization_id: string
          provider: string
          published_at?: string | null
          status?: string
          superseded_at?: string | null
          system_prompt: string
          token_budget?: number
          tool_ids?: string[]
          trigger_config?: Json
          version_number: number
        }
        Update: {
          agent_id?: string
          channel_session_id?: string
          cost_budget_cents?: number
          created_at?: string
          created_by?: string | null
          credential_id?: string | null
          handoff_keywords?: string[]
          handoff_tool_enabled?: boolean
          history_message_window?: number
          history_token_window?: number
          id?: string
          max_steps?: number
          model?: string
          organization_id?: string
          provider?: string
          published_at?: string | null
          status?: string
          superseded_at?: string | null
          system_prompt?: string
          token_budget?: number
          tool_ids?: string[]
          trigger_config?: Json
          version_number?: number
        }
        Relationships: [
          {
            foreignKeyName: "ai_agent_versions_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "ai_agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_agent_versions_channel_session_id_fkey"
            columns: ["channel_session_id"]
            isOneToOne: false
            referencedRelation: "channel_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_agent_versions_credential_id_fkey"
            columns: ["credential_id"]
            isOneToOne: false
            referencedRelation: "ai_provider_credentials"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_agent_versions_credential_id_fkey"
            columns: ["credential_id"]
            isOneToOne: false
            referencedRelation: "ai_provider_credentials_safe"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_agent_versions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_agents: {
        Row: {
          active_kb_version_id: string | null
          archived_at: string | null
          config: Json
          created_at: string
          created_by: string | null
          description: string | null
          guardrails: Json
          id: string
          is_active: boolean
          is_default: boolean
          kind: string
          model: string
          name: string
          organization_id: string
          priority: number
          published_version_id: string | null
          system_prompt: string
          updated_at: string
        }
        Insert: {
          active_kb_version_id?: string | null
          archived_at?: string | null
          config?: Json
          created_at?: string
          created_by?: string | null
          description?: string | null
          guardrails?: Json
          id?: string
          is_active?: boolean
          is_default?: boolean
          kind?: string
          model?: string
          name: string
          organization_id: string
          priority?: number
          published_version_id?: string | null
          system_prompt: string
          updated_at?: string
        }
        Update: {
          active_kb_version_id?: string | null
          archived_at?: string | null
          config?: Json
          created_at?: string
          created_by?: string | null
          description?: string | null
          guardrails?: Json
          id?: string
          is_active?: boolean
          is_default?: boolean
          kind?: string
          model?: string
          name?: string
          organization_id?: string
          priority?: number
          published_version_id?: string | null
          system_prompt?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_agents_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_agents_published_version_id_fkey"
            columns: ["published_version_id"]
            isOneToOne: false
            referencedRelation: "ai_agent_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_budgets: {
        Row: {
          action_at_100pct: string
          alarm_threshold_pct: number
          current_month_consumed_cents: number
          current_period_start: string
          is_disabled: boolean
          is_throttled: boolean
          last_alarm_sent_at: string | null
          monthly_limit_cents: number
          organization_id: string
          updated_at: string
        }
        Insert: {
          action_at_100pct?: string
          alarm_threshold_pct?: number
          current_month_consumed_cents?: number
          current_period_start?: string
          is_disabled?: boolean
          is_throttled?: boolean
          last_alarm_sent_at?: string | null
          monthly_limit_cents?: number
          organization_id: string
          updated_at?: string
        }
        Update: {
          action_at_100pct?: string
          alarm_threshold_pct?: number
          current_month_consumed_cents?: number
          current_period_start?: string
          is_disabled?: boolean
          is_throttled?: boolean
          last_alarm_sent_at?: string | null
          monthly_limit_cents?: number
          organization_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_budgets_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: true
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_chunks: {
        Row: {
          content: string
          content_hash: string
          created_at: string
          embedding: string
          id: string
          kb_version_id: string
          knowledge_source_id: string
          metadata: Json
          organization_id: string
          position: number
          token_count: number
        }
        Insert: {
          content: string
          content_hash: string
          created_at?: string
          embedding: string
          id?: string
          kb_version_id: string
          knowledge_source_id: string
          metadata?: Json
          organization_id: string
          position: number
          token_count: number
        }
        Update: {
          content?: string
          content_hash?: string
          created_at?: string
          embedding?: string
          id?: string
          kb_version_id?: string
          knowledge_source_id?: string
          metadata?: Json
          organization_id?: string
          position?: number
          token_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "ai_chunks_knowledge_source_id_fkey"
            columns: ["knowledge_source_id"]
            isOneToOne: false
            referencedRelation: "ai_knowledge_sources"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_chunks_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_faq_items: {
        Row: {
          answer: string
          created_at: string
          id: string
          knowledge_source_id: string
          locale: string
          organization_id: string
          position: number
          question: string
          tags: string[]
          updated_at: string
        }
        Insert: {
          answer: string
          created_at?: string
          id?: string
          knowledge_source_id: string
          locale?: string
          organization_id: string
          position?: number
          question: string
          tags?: string[]
          updated_at?: string
        }
        Update: {
          answer?: string
          created_at?: string
          id?: string
          knowledge_source_id?: string
          locale?: string
          organization_id?: string
          position?: number
          question?: string
          tags?: string[]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_faq_items_knowledge_source_id_fkey"
            columns: ["knowledge_source_id"]
            isOneToOne: false
            referencedRelation: "ai_knowledge_sources"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_faq_items_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_invocations: {
        Row: {
          agent_id: string
          citations: Json
          completion_tokens: number
          conversation_id: string | null
          cost_cents: number
          created_at: string
          error_payload: Json | null
          finish_reason: string | null
          id: string
          invocation_kind: string
          latency_ms: number
          message_id: string | null
          model: string
          organization_id: string
          prompt_blob_path: string | null
          prompt_tokens: number
          response_blob_path: string | null
          total_tokens: number | null
        }
        Insert: {
          agent_id: string
          citations?: Json
          completion_tokens?: number
          conversation_id?: string | null
          cost_cents?: number
          created_at?: string
          error_payload?: Json | null
          finish_reason?: string | null
          id?: string
          invocation_kind: string
          latency_ms: number
          message_id?: string | null
          model: string
          organization_id: string
          prompt_blob_path?: string | null
          prompt_tokens?: number
          response_blob_path?: string | null
          total_tokens?: number | null
        }
        Update: {
          agent_id?: string
          citations?: Json
          completion_tokens?: number
          conversation_id?: string | null
          cost_cents?: number
          created_at?: string
          error_payload?: Json | null
          finish_reason?: string | null
          id?: string
          invocation_kind?: string
          latency_ms?: number
          message_id?: string | null
          model?: string
          organization_id?: string
          prompt_blob_path?: string | null
          prompt_tokens?: number
          response_blob_path?: string | null
          total_tokens?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "ai_invocations_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "ai_agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_invocations_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_invocations_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_invocations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_knowledge_sources: {
        Row: {
          agent_id: string
          chunks_count: number
          created_at: string
          id: string
          ingested_at: string | null
          is_active: boolean
          last_index_error: string | null
          last_index_status: string | null
          last_indexed_at: string | null
          name: string
          organization_id: string
          source_metadata: Json
          source_type: string
          status: string
          updated_at: string
        }
        Insert: {
          agent_id: string
          chunks_count?: number
          created_at?: string
          id?: string
          ingested_at?: string | null
          is_active?: boolean
          last_index_error?: string | null
          last_index_status?: string | null
          last_indexed_at?: string | null
          name?: string
          organization_id: string
          source_metadata?: Json
          source_type: string
          status?: string
          updated_at?: string
        }
        Update: {
          agent_id?: string
          chunks_count?: number
          created_at?: string
          id?: string
          ingested_at?: string | null
          is_active?: boolean
          last_index_error?: string | null
          last_index_status?: string | null
          last_indexed_at?: string | null
          name?: string
          organization_id?: string
          source_metadata?: Json
          source_type?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_knowledge_sources_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "ai_agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_knowledge_sources_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_knowledge_versions: {
        Row: {
          activated_at: string | null
          activated_by: string | null
          agent_id: string
          created_at: string
          description: string | null
          error_message: string | null
          id: string
          indexed_at: string | null
          is_active: boolean
          organization_id: string
          sources_snapshot: Json
          status: string | null
          total_chunks: number
          version_number: number
        }
        Insert: {
          activated_at?: string | null
          activated_by?: string | null
          agent_id: string
          created_at?: string
          description?: string | null
          error_message?: string | null
          id?: string
          indexed_at?: string | null
          is_active?: boolean
          organization_id: string
          sources_snapshot?: Json
          status?: string | null
          total_chunks?: number
          version_number: number
        }
        Update: {
          activated_at?: string | null
          activated_by?: string | null
          agent_id?: string
          created_at?: string
          description?: string | null
          error_message?: string | null
          id?: string
          indexed_at?: string | null
          is_active?: boolean
          organization_id?: string
          sources_snapshot?: Json
          status?: string | null
          total_chunks?: number
          version_number?: number
        }
        Relationships: [
          {
            foreignKeyName: "ai_knowledge_versions_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "ai_agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_knowledge_versions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_models: {
        Row: {
          context_window: number | null
          deprecated_at: string | null
          description: string | null
          display_name: string
          id: string
          input_price_per_million_cents: number | null
          is_default_for_provider: boolean
          metadata: Json
          model_id: string
          output_price_per_million_cents: number | null
          provider: string
          released_at: string | null
          supports_tools: boolean
        }
        Insert: {
          context_window?: number | null
          deprecated_at?: string | null
          description?: string | null
          display_name: string
          id?: string
          input_price_per_million_cents?: number | null
          is_default_for_provider?: boolean
          metadata?: Json
          model_id: string
          output_price_per_million_cents?: number | null
          provider: string
          released_at?: string | null
          supports_tools?: boolean
        }
        Update: {
          context_window?: number | null
          deprecated_at?: string | null
          description?: string | null
          display_name?: string
          id?: string
          input_price_per_million_cents?: number | null
          is_default_for_provider?: boolean
          metadata?: Json
          model_id?: string
          output_price_per_million_cents?: number | null
          provider?: string
          released_at?: string | null
          supports_tools?: boolean
        }
        Relationships: []
      }
      ai_pricing: {
        Row: {
          completion_cents_per_million_tokens: number | null
          effective_from: string
          embedding_cents_per_million_tokens: number | null
          model: string
          notes: string | null
          prompt_cents_per_million_tokens: number | null
          superseded_at: string | null
        }
        Insert: {
          completion_cents_per_million_tokens?: number | null
          effective_from?: string
          embedding_cents_per_million_tokens?: number | null
          model: string
          notes?: string | null
          prompt_cents_per_million_tokens?: number | null
          superseded_at?: string | null
        }
        Update: {
          completion_cents_per_million_tokens?: number | null
          effective_from?: string
          embedding_cents_per_million_tokens?: number | null
          model?: string
          notes?: string | null
          prompt_cents_per_million_tokens?: number | null
          superseded_at?: string | null
        }
        Relationships: []
      }
      ai_provider_credentials: {
        Row: {
          api_key_encrypted: string
          api_key_iv: string
          api_key_last4: string
          api_key_tag: string
          created_at: string
          created_by: string | null
          id: string
          is_active: boolean
          label: string
          models_available: string[] | null
          organization_id: string
          provider: string
          updated_at: string
          validated_at: string | null
          validation_error: string | null
        }
        Insert: {
          api_key_encrypted: string
          api_key_iv: string
          api_key_last4: string
          api_key_tag: string
          created_at?: string
          created_by?: string | null
          id?: string
          is_active?: boolean
          label: string
          models_available?: string[] | null
          organization_id: string
          provider: string
          updated_at?: string
          validated_at?: string | null
          validation_error?: string | null
        }
        Update: {
          api_key_encrypted?: string
          api_key_iv?: string
          api_key_last4?: string
          api_key_tag?: string
          created_at?: string
          created_by?: string | null
          id?: string
          is_active?: boolean
          label?: string
          models_available?: string[] | null
          organization_id?: string
          provider?: string
          updated_at?: string
          validated_at?: string | null
          validation_error?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ai_provider_credentials_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      api_audit_log: {
        Row: {
          acting_as_platform_admin: boolean
          action: string
          actor_api_token_id: string | null
          actor_ip: unknown
          actor_user_agent: string | null
          actor_user_id: string | null
          bypassed_rls: boolean
          created_at: string
          id: string
          metadata: Json
          organization_id: string | null
          request_id: string | null
          resource_id: string | null
          resource_type: string | null
        }
        Insert: {
          acting_as_platform_admin?: boolean
          action: string
          actor_api_token_id?: string | null
          actor_ip?: unknown
          actor_user_agent?: string | null
          actor_user_id?: string | null
          bypassed_rls?: boolean
          created_at?: string
          id?: string
          metadata?: Json
          organization_id?: string | null
          request_id?: string | null
          resource_id?: string | null
          resource_type?: string | null
        }
        Update: {
          acting_as_platform_admin?: boolean
          action?: string
          actor_api_token_id?: string | null
          actor_ip?: unknown
          actor_user_agent?: string | null
          actor_user_id?: string | null
          bypassed_rls?: boolean
          created_at?: string
          id?: string
          metadata?: Json
          organization_id?: string | null
          request_id?: string | null
          resource_id?: string | null
          resource_type?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "api_audit_log_actor_api_token_id_fkey"
            columns: ["actor_api_token_id"]
            isOneToOne: false
            referencedRelation: "api_tokens"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "api_audit_log_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      api_tokens: {
        Row: {
          created_at: string
          created_by: string
          expires_at: string | null
          id: string
          last_used_at: string | null
          last_used_ip: unknown
          name: string
          organization_id: string
          prefix: string
          revoked_at: string | null
          revoked_by: string | null
          scopes: Json
          token_hash: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by: string
          expires_at?: string | null
          id?: string
          last_used_at?: string | null
          last_used_ip?: unknown
          name: string
          organization_id: string
          prefix: string
          revoked_at?: string | null
          revoked_by?: string | null
          scopes?: Json
          token_hash: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string
          expires_at?: string | null
          id?: string
          last_used_at?: string | null
          last_used_ip?: unknown
          name?: string
          organization_id?: string
          prefix?: string
          revoked_at?: string | null
          revoked_by?: string | null
          scopes?: Json
          token_hash?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "api_tokens_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      attendant_availability: {
        Row: {
          capacity: number
          id: string
          is_available: boolean
          last_heartbeat_at: string | null
          organization_id: string
          schedule: Json
          updated_at: string
          user_id: string
        }
        Insert: {
          capacity?: number
          id?: string
          is_available?: boolean
          last_heartbeat_at?: string | null
          organization_id: string
          schedule?: Json
          updated_at?: string
          user_id: string
        }
        Update: {
          capacity?: number
          id?: string
          is_available?: boolean
          last_heartbeat_at?: string | null
          organization_id?: string
          schedule?: Json
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "attendant_availability_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      automation_rule_runs: {
        Row: {
          actions_result: Json
          created_at: string
          error: string | null
          event_id: string | null
          id: string
          organization_id: string
          rule_id: string
          status: string
        }
        Insert: {
          actions_result?: Json
          created_at?: string
          error?: string | null
          event_id?: string | null
          id?: string
          organization_id: string
          rule_id: string
          status: string
        }
        Update: {
          actions_result?: Json
          created_at?: string
          error?: string | null
          event_id?: string | null
          id?: string
          organization_id?: string
          rule_id?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "automation_rule_runs_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "event_log"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "automation_rule_runs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "automation_rule_runs_rule_id_fkey"
            columns: ["rule_id"]
            isOneToOne: false
            referencedRelation: "automation_rules"
            referencedColumns: ["id"]
          },
        ]
      }
      automation_rules: {
        Row: {
          actions: Json
          conditions: Json
          created_at: string
          created_by_user_id: string | null
          id: string
          is_active: boolean
          last_run_at: string | null
          name: string
          organization_id: string
          run_count: number
          trigger_event: string
          updated_at: string
        }
        Insert: {
          actions?: Json
          conditions?: Json
          created_at?: string
          created_by_user_id?: string | null
          id?: string
          is_active?: boolean
          last_run_at?: string | null
          name: string
          organization_id: string
          run_count?: number
          trigger_event: string
          updated_at?: string
        }
        Update: {
          actions?: Json
          conditions?: Json
          created_at?: string
          created_by_user_id?: string | null
          id?: string
          is_active?: boolean
          last_run_at?: string | null
          name?: string
          organization_id?: string
          run_count?: number
          trigger_event?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "automation_rules_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      before_send_traces: {
        Row: {
          channel_session_id: string
          contact_id: string | null
          created_at: string
          id: string
          job_id: string
          organization_id: string
          trace: Json
          vetoed_code: string | null
          vetoed_gate: string | null
        }
        Insert: {
          channel_session_id: string
          contact_id?: string | null
          created_at?: string
          id?: string
          job_id: string
          organization_id: string
          trace: Json
          vetoed_code?: string | null
          vetoed_gate?: string | null
        }
        Update: {
          channel_session_id?: string
          contact_id?: string | null
          created_at?: string
          id?: string
          job_id?: string
          organization_id?: string
          trace?: Json
          vetoed_code?: string | null
          vetoed_gate?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "before_send_traces_channel_session_id_fkey"
            columns: ["channel_session_id"]
            isOneToOne: false
            referencedRelation: "channel_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "before_send_traces_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "before_send_traces_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "job_queue"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "before_send_traces_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      channel_knobs: {
        Row: {
          allow_sunday: boolean | null
          channel_session_id: string
          created_at: string
          health_knobs: Json | null
          jitter_max_ms: number | null
          number_activated_at: string
          organization_id: string
          spinning_knobs: Json | null
          throttle_ms: number | null
          timezone: string | null
          updated_at: string
          warmup_daily_caps: Json | null
          window_end_hour: number | null
          window_start_hour: number | null
        }
        Insert: {
          allow_sunday?: boolean | null
          channel_session_id: string
          created_at?: string
          health_knobs?: Json | null
          jitter_max_ms?: number | null
          number_activated_at?: string
          organization_id: string
          spinning_knobs?: Json | null
          throttle_ms?: number | null
          timezone?: string | null
          updated_at?: string
          warmup_daily_caps?: Json | null
          window_end_hour?: number | null
          window_start_hour?: number | null
        }
        Update: {
          allow_sunday?: boolean | null
          channel_session_id?: string
          created_at?: string
          health_knobs?: Json | null
          jitter_max_ms?: number | null
          number_activated_at?: string
          organization_id?: string
          spinning_knobs?: Json | null
          throttle_ms?: number | null
          timezone?: string | null
          updated_at?: string
          warmup_daily_caps?: Json | null
          window_end_hour?: number | null
          window_start_hour?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "channel_knobs_channel_session_id_fkey"
            columns: ["channel_session_id"]
            isOneToOne: false
            referencedRelation: "channel_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "channel_knobs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      channel_session_health: {
        Row: {
          channel_session_id: string
          escalated_status: string | null
          health_held_at: string | null
          health_hold_active: boolean
          health_hold_reason: string | null
          health_released_at: string | null
          id: string
          organization_id: string
          status: string
          status_changed_at: string
          updated_at: string
        }
        Insert: {
          channel_session_id: string
          escalated_status?: string | null
          health_held_at?: string | null
          health_hold_active?: boolean
          health_hold_reason?: string | null
          health_released_at?: string | null
          id?: string
          organization_id: string
          status: string
          status_changed_at?: string
          updated_at?: string
        }
        Update: {
          channel_session_id?: string
          escalated_status?: string | null
          health_held_at?: string | null
          health_hold_active?: boolean
          health_hold_reason?: string | null
          health_released_at?: string | null
          id?: string
          organization_id?: string
          status?: string
          status_changed_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "channel_session_health_channel_session_id_fkey"
            columns: ["channel_session_id"]
            isOneToOne: false
            referencedRelation: "channel_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "channel_session_health_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      channel_session_warmup: {
        Row: {
          channel_session_id: string
          day: string
          id: string
          messages_received: number
          messages_sent: number
          organization_id: string
          unique_contacts: number
        }
        Insert: {
          channel_session_id: string
          day: string
          id?: string
          messages_received?: number
          messages_sent?: number
          organization_id: string
          unique_contacts?: number
        }
        Update: {
          channel_session_id?: string
          day?: string
          id?: string
          messages_received?: number
          messages_sent?: number
          organization_id?: string
          unique_contacts?: number
        }
        Relationships: [
          {
            foreignKeyName: "channel_session_warmup_channel_session_id_fkey"
            columns: ["channel_session_id"]
            isOneToOne: false
            referencedRelation: "channel_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "channel_session_warmup_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      channel_sessions: {
        Row: {
          consecutive_health_fails: number
          created_at: string
          created_by: string | null
          daily_message_limit: number
          display_name: string | null
          engine: string
          id: string
          is_warmup_complete: boolean | null
          last_health_check_at: string | null
          last_status_change_at: string
          metadata: Json
          organization_id: string
          phone_number: string | null
          status: string
          status_reason: string | null
          updated_at: string
          waha_session_name: string
          warmup_completed_at: string | null
          warmup_started_at: string | null
          webhook_path_token: string
          webhook_secret_encrypted: string
        }
        Insert: {
          consecutive_health_fails?: number
          created_at?: string
          created_by?: string | null
          daily_message_limit?: number
          display_name?: string | null
          engine?: string
          id?: string
          is_warmup_complete?: boolean | null
          last_health_check_at?: string | null
          last_status_change_at?: string
          metadata?: Json
          organization_id: string
          phone_number?: string | null
          status?: string
          status_reason?: string | null
          updated_at?: string
          waha_session_name: string
          warmup_completed_at?: string | null
          warmup_started_at?: string | null
          webhook_path_token?: string
          webhook_secret_encrypted: string
        }
        Update: {
          consecutive_health_fails?: number
          created_at?: string
          created_by?: string | null
          daily_message_limit?: number
          display_name?: string | null
          engine?: string
          id?: string
          is_warmup_complete?: boolean | null
          last_health_check_at?: string | null
          last_status_change_at?: string
          metadata?: Json
          organization_id?: string
          phone_number?: string | null
          status?: string
          status_reason?: string | null
          updated_at?: string
          waha_session_name?: string
          warmup_completed_at?: string | null
          warmup_started_at?: string | null
          webhook_path_token?: string
          webhook_secret_encrypted?: string
        }
        Relationships: [
          {
            foreignKeyName: "channel_sessions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      contacts: {
        Row: {
          anonymized_at: string | null
          birthdate: string | null
          blocked_at: string | null
          blocked_reason: string | null
          consent: Json
          cpf_encrypted: string | null
          cpf_hash: string | null
          created_at: string
          created_by_user_id: string | null
          display_name: string | null
          email: string | null
          email_normalized: string | null
          force_human: boolean
          id: string
          is_anonymized: boolean
          is_blocked: boolean
          is_merged_into: string | null
          last_activity_at: string | null
          merged_at: string | null
          name: string | null
          organization_id: string
          phone_number: string | null
          source: string
          source_metadata: Json
          tags: string[]
          updated_at: string
          wa_identity: string | null
        }
        Insert: {
          anonymized_at?: string | null
          birthdate?: string | null
          blocked_at?: string | null
          blocked_reason?: string | null
          consent?: Json
          cpf_encrypted?: string | null
          cpf_hash?: string | null
          created_at?: string
          created_by_user_id?: string | null
          display_name?: string | null
          email?: string | null
          email_normalized?: string | null
          force_human?: boolean
          id?: string
          is_anonymized?: boolean
          is_blocked?: boolean
          is_merged_into?: string | null
          last_activity_at?: string | null
          merged_at?: string | null
          name?: string | null
          organization_id: string
          phone_number?: string | null
          source?: string
          source_metadata?: Json
          tags?: string[]
          updated_at?: string
          wa_identity?: string | null
        }
        Update: {
          anonymized_at?: string | null
          birthdate?: string | null
          blocked_at?: string | null
          blocked_reason?: string | null
          consent?: Json
          cpf_encrypted?: string | null
          cpf_hash?: string | null
          created_at?: string
          created_by_user_id?: string | null
          display_name?: string | null
          email?: string | null
          email_normalized?: string | null
          force_human?: boolean
          id?: string
          is_anonymized?: boolean
          is_blocked?: boolean
          is_merged_into?: string | null
          last_activity_at?: string | null
          merged_at?: string | null
          name?: string | null
          organization_id?: string
          phone_number?: string | null
          source?: string
          source_metadata?: Json
          tags?: string[]
          updated_at?: string
          wa_identity?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "contacts_is_merged_into_fkey"
            columns: ["is_merged_into"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contacts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      conversation_assignment_events: {
        Row: {
          changed_by: string | null
          conversation_id: string
          created_at: string
          from_user_id: string | null
          id: string
          organization_id: string
          reason: string
          to_user_id: string | null
        }
        Insert: {
          changed_by?: string | null
          conversation_id: string
          created_at?: string
          from_user_id?: string | null
          id?: string
          organization_id: string
          reason: string
          to_user_id?: string | null
        }
        Update: {
          changed_by?: string | null
          conversation_id?: string
          created_at?: string
          from_user_id?: string | null
          id?: string
          organization_id?: string
          reason?: string
          to_user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "conversation_assignment_events_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversation_assignment_events_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      conversations: {
        Row: {
          assigned_at: string | null
          assigned_to_user_id: string | null
          assignee_kind: string | null
          bot_silenced_until: string | null
          channel: string
          channel_session_id: string
          contact_id: string
          created_at: string
          group_chat_id: string | null
          id: string
          is_group: boolean
          last_handoff_at: string | null
          last_handoff_reason: string | null
          last_inbound_at: string | null
          last_message_at: string | null
          last_message_preview: string | null
          last_outbound_at: string | null
          metadata: Json
          organization_id: string
          rag_review_status: string | null
          status: string
          status_changed_at: string
          tags: string[]
          unread_count_for_assignee: number
          updated_at: string
          usable_for_rag: boolean
          usable_for_rag_marked_at: string | null
          usable_for_rag_marked_by: string | null
        }
        Insert: {
          assigned_at?: string | null
          assigned_to_user_id?: string | null
          assignee_kind?: string | null
          bot_silenced_until?: string | null
          channel?: string
          channel_session_id: string
          contact_id: string
          created_at?: string
          group_chat_id?: string | null
          id?: string
          is_group?: boolean
          last_handoff_at?: string | null
          last_handoff_reason?: string | null
          last_inbound_at?: string | null
          last_message_at?: string | null
          last_message_preview?: string | null
          last_outbound_at?: string | null
          metadata?: Json
          organization_id: string
          rag_review_status?: string | null
          status?: string
          status_changed_at?: string
          tags?: string[]
          unread_count_for_assignee?: number
          updated_at?: string
          usable_for_rag?: boolean
          usable_for_rag_marked_at?: string | null
          usable_for_rag_marked_by?: string | null
        }
        Update: {
          assigned_at?: string | null
          assigned_to_user_id?: string | null
          assignee_kind?: string | null
          bot_silenced_until?: string | null
          channel?: string
          channel_session_id?: string
          contact_id?: string
          created_at?: string
          group_chat_id?: string | null
          id?: string
          is_group?: boolean
          last_handoff_at?: string | null
          last_handoff_reason?: string | null
          last_inbound_at?: string | null
          last_message_at?: string | null
          last_message_preview?: string | null
          last_outbound_at?: string | null
          metadata?: Json
          organization_id?: string
          rag_review_status?: string | null
          status?: string
          status_changed_at?: string
          tags?: string[]
          unread_count_for_assignee?: number
          updated_at?: string
          usable_for_rag?: boolean
          usable_for_rag_marked_at?: string | null
          usable_for_rag_marked_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "conversations_channel_session_id_fkey"
            columns: ["channel_session_id"]
            isOneToOne: false
            referencedRelation: "channel_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      crm_lead_activities: {
        Row: {
          contact_id: string | null
          created_at: string
          id: string
          lead_id: string
          metadata: Json
          organization_id: string
          payload: Json
          performed_at: string
          performed_by_user_id: string | null
          source_id: string | null
          source_module: string
          type: string
        }
        Insert: {
          contact_id?: string | null
          created_at?: string
          id?: string
          lead_id: string
          metadata?: Json
          organization_id: string
          payload?: Json
          performed_at?: string
          performed_by_user_id?: string | null
          source_id?: string | null
          source_module: string
          type: string
        }
        Update: {
          contact_id?: string | null
          created_at?: string
          id?: string
          lead_id?: string
          metadata?: Json
          organization_id?: string
          payload?: Json
          performed_at?: string
          performed_by_user_id?: string | null
          source_id?: string | null
          source_module?: string
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "crm_lead_activities_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "crm_lead_activities_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "crm_leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "crm_lead_activities_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      crm_lead_links: {
        Row: {
          created_at: string
          created_by_user_id: string | null
          id: string
          lead_id: string
          link_kind: string
          metadata: Json
          organization_id: string
          target_id: string
          target_kind: string
        }
        Insert: {
          created_at?: string
          created_by_user_id?: string | null
          id?: string
          lead_id: string
          link_kind: string
          metadata?: Json
          organization_id: string
          target_id: string
          target_kind: string
        }
        Update: {
          created_at?: string
          created_by_user_id?: string | null
          id?: string
          lead_id?: string
          link_kind?: string
          metadata?: Json
          organization_id?: string
          target_id?: string
          target_kind?: string
        }
        Relationships: [
          {
            foreignKeyName: "crm_lead_links_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "crm_leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "crm_lead_links_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      crm_leads: {
        Row: {
          assigned_at: string | null
          closed_at: string | null
          contact_id: string | null
          created_at: string
          created_by_user_id: string | null
          currency: string | null
          custom_fields: Json
          description: string | null
          expected_close_date: string | null
          external_id: string | null
          id: string
          last_activity_at: string | null
          lost_reason: string | null
          organization_id: string
          owner_user_id: string | null
          pipeline_id: string
          position_in_stage: number
          source: string
          source_metadata: Json
          stage_id: string
          status: string
          tags: string[]
          title: string
          updated_at: string
          value_cents: number | null
        }
        Insert: {
          assigned_at?: string | null
          closed_at?: string | null
          contact_id?: string | null
          created_at?: string
          created_by_user_id?: string | null
          currency?: string | null
          custom_fields?: Json
          description?: string | null
          expected_close_date?: string | null
          external_id?: string | null
          id?: string
          last_activity_at?: string | null
          lost_reason?: string | null
          organization_id: string
          owner_user_id?: string | null
          pipeline_id: string
          position_in_stage?: number
          source?: string
          source_metadata?: Json
          stage_id: string
          status?: string
          tags?: string[]
          title: string
          updated_at?: string
          value_cents?: number | null
        }
        Update: {
          assigned_at?: string | null
          closed_at?: string | null
          contact_id?: string | null
          created_at?: string
          created_by_user_id?: string | null
          currency?: string | null
          custom_fields?: Json
          description?: string | null
          expected_close_date?: string | null
          external_id?: string | null
          id?: string
          last_activity_at?: string | null
          lost_reason?: string | null
          organization_id?: string
          owner_user_id?: string | null
          pipeline_id?: string
          position_in_stage?: number
          source?: string
          source_metadata?: Json
          stage_id?: string
          status?: string
          tags?: string[]
          title?: string
          updated_at?: string
          value_cents?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "crm_leads_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "crm_leads_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "crm_leads_pipeline_id_fkey"
            columns: ["pipeline_id"]
            isOneToOne: false
            referencedRelation: "crm_pipelines"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "crm_leads_stage_id_fkey"
            columns: ["stage_id"]
            isOneToOne: false
            referencedRelation: "crm_stages"
            referencedColumns: ["id"]
          },
        ]
      }
      crm_pipelines: {
        Row: {
          created_at: string
          description: string | null
          id: string
          is_archived: boolean
          is_default: boolean
          name: string
          organization_id: string
          position: number
          settings: Json
          slug: string
          updated_at: string
          vocabulary: Json
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          is_archived?: boolean
          is_default?: boolean
          name: string
          organization_id: string
          position?: number
          settings?: Json
          slug: string
          updated_at?: string
          vocabulary?: Json
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          is_archived?: boolean
          is_default?: boolean
          name?: string
          organization_id?: string
          position?: number
          settings?: Json
          slug?: string
          updated_at?: string
          vocabulary?: Json
        }
        Relationships: [
          {
            foreignKeyName: "crm_pipelines_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      crm_stages: {
        Row: {
          color: string | null
          created_at: string
          description: string | null
          expected_duration_hours: number | null
          id: string
          is_archived: boolean
          is_lost: boolean
          is_won: boolean
          name: string
          organization_id: string
          pipeline_id: string
          position: number
          requires_human: boolean
          slug: string
          updated_at: string
        }
        Insert: {
          color?: string | null
          created_at?: string
          description?: string | null
          expected_duration_hours?: number | null
          id?: string
          is_archived?: boolean
          is_lost?: boolean
          is_won?: boolean
          name: string
          organization_id: string
          pipeline_id: string
          position: number
          requires_human?: boolean
          slug: string
          updated_at?: string
        }
        Update: {
          color?: string | null
          created_at?: string
          description?: string | null
          expected_duration_hours?: number | null
          id?: string
          is_archived?: boolean
          is_lost?: boolean
          is_won?: boolean
          name?: string
          organization_id?: string
          pipeline_id?: string
          position?: number
          requires_human?: boolean
          slug?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "crm_stages_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "crm_stages_pipeline_id_fkey"
            columns: ["pipeline_id"]
            isOneToOne: false
            referencedRelation: "crm_pipelines"
            referencedColumns: ["id"]
          },
        ]
      }
      cron_jobs: {
        Row: {
          attempts: number
          contact_id: string
          created_at: string
          cron_expr: string | null
          enabled: boolean
          id: string
          interval_ms: number | null
          job_kind: string
          kind: string
          last_error: string | null
          max_attempts: number
          next_run_at: string
          organization_id: string
          payload: Json
          tz: string
          updated_at: string
        }
        Insert: {
          attempts?: number
          contact_id: string
          created_at?: string
          cron_expr?: string | null
          enabled?: boolean
          id?: string
          interval_ms?: number | null
          job_kind?: string
          kind: string
          last_error?: string | null
          max_attempts?: number
          next_run_at: string
          organization_id: string
          payload?: Json
          tz?: string
          updated_at?: string
        }
        Update: {
          attempts?: number
          contact_id?: string
          created_at?: string
          cron_expr?: string | null
          enabled?: boolean
          id?: string
          interval_ms?: number | null
          job_kind?: string
          kind?: string
          last_error?: string | null
          max_attempts?: number
          next_run_at?: string
          organization_id?: string
          payload?: Json
          tz?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "cron_jobs_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cron_jobs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      disclosure_template_pointers: {
        Row: {
          organization_id: string
          updated_at: string
          version_id: string
        }
        Insert: {
          organization_id: string
          updated_at?: string
          version_id: string
        }
        Update: {
          organization_id?: string
          updated_at?: string
          version_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "disclosure_template_pointers_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "disclosure_template_pointers_version_id_fkey"
            columns: ["version_id"]
            isOneToOne: false
            referencedRelation: "disclosure_template_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      disclosure_template_versions: {
        Row: {
          body: string
          created_at: string
          id: string
          organization_id: string
        }
        Insert: {
          body: string
          created_at?: string
          id?: string
          organization_id: string
        }
        Update: {
          body?: string
          created_at?: string
          id?: string
          organization_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "disclosure_template_versions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      event_log: {
        Row: {
          attempts: number
          consumed_by: string[]
          created_at: string
          entity_id: string | null
          entity_kind: string
          event_type: string
          id: string
          last_error: string | null
          metadata: Json
          next_attempt_at: string | null
          organization_id: string
          payload: Json
          status: string
          updated_at: string
        }
        Insert: {
          attempts?: number
          consumed_by?: string[]
          created_at?: string
          entity_id?: string | null
          entity_kind: string
          event_type: string
          id?: string
          last_error?: string | null
          metadata?: Json
          next_attempt_at?: string | null
          organization_id: string
          payload?: Json
          status?: string
          updated_at?: string
        }
        Update: {
          attempts?: number
          consumed_by?: string[]
          created_at?: string
          entity_id?: string | null
          entity_kind?: string
          event_type?: string
          id?: string
          last_error?: string | null
          metadata?: Json
          next_attempt_at?: string | null
          organization_id?: string
          payload?: Json
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "event_log_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      flywheel_distiller_proposals: {
        Row: {
          content: string
          dataset: string
          evidence: Json
          id: string
          organization_id: string
          proposed_at: string
          run_id: string
          target: string
          type: string
        }
        Insert: {
          content: string
          dataset: string
          evidence: Json
          id?: string
          organization_id: string
          proposed_at?: string
          run_id: string
          target: string
          type: string
        }
        Update: {
          content?: string
          dataset?: string
          evidence?: Json
          id?: string
          organization_id?: string
          proposed_at?: string
          run_id?: string
          target?: string
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "flywheel_distiller_proposals_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      flywheel_judge_verdicts: {
        Row: {
          dataset: string
          dimension: string
          id: string
          judge_family: string
          judged_at: string
          model: string
          option_order: string
          organization_id: string
          provenance: Json
          run_id: string
          trace_id: string
          verdict: string
        }
        Insert: {
          dataset: string
          dimension: string
          id?: string
          judge_family: string
          judged_at?: string
          model: string
          option_order: string
          organization_id: string
          provenance?: Json
          run_id: string
          trace_id: string
          verdict: string
        }
        Update: {
          dataset?: string
          dimension?: string
          id?: string
          judge_family?: string
          judged_at?: string
          model?: string
          option_order?: string
          organization_id?: string
          provenance?: Json
          run_id?: string
          trace_id?: string
          verdict?: string
        }
        Relationships: [
          {
            foreignKeyName: "flywheel_judge_verdicts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      idempotency_keys: {
        Row: {
          created_at: string
          endpoint: string
          expires_at: string
          id: string
          key: string
          organization_id: string
          request_hash: string
          response_body: Json
          status_code: number
        }
        Insert: {
          created_at?: string
          endpoint: string
          expires_at?: string
          id?: string
          key: string
          organization_id: string
          request_hash: string
          response_body: Json
          status_code: number
        }
        Update: {
          created_at?: string
          endpoint?: string
          expires_at?: string
          id?: string
          key?: string
          organization_id?: string
          request_hash?: string
          response_body?: Json
          status_code?: number
        }
        Relationships: [
          {
            foreignKeyName: "idempotency_keys_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      incidents: {
        Row: {
          acknowledged_at: string | null
          acknowledged_by: string | null
          created_at: string
          id: string
          organization_id: string | null
          payload: Json
          resolution_note: string | null
          resolved_at: string | null
          resolved_by: string | null
          severity: string
          status: string
          type: string
          updated_at: string
        }
        Insert: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          created_at?: string
          id?: string
          organization_id?: string | null
          payload?: Json
          resolution_note?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          severity: string
          status?: string
          type: string
          updated_at?: string
        }
        Update: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          created_at?: string
          id?: string
          organization_id?: string | null
          payload?: Json
          resolution_note?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          severity?: string
          status?: string
          type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "incidents_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      job_queue: {
        Row: {
          attempts: number
          contact_id: string | null
          created_at: string
          id: string
          kind: string
          last_error: string | null
          locked_at: string | null
          locked_by: string | null
          max_attempts: number
          organization_id: string
          payload: Json
          priority: number
          run_after: string
          source_event_id: string | null
          status: string
        }
        Insert: {
          attempts?: number
          contact_id?: string | null
          created_at?: string
          id?: string
          kind: string
          last_error?: string | null
          locked_at?: string | null
          locked_by?: string | null
          max_attempts?: number
          organization_id: string
          payload?: Json
          priority?: number
          run_after?: string
          source_event_id?: string | null
          status?: string
        }
        Update: {
          attempts?: number
          contact_id?: string | null
          created_at?: string
          id?: string
          kind?: string
          last_error?: string | null
          locked_at?: string | null
          locked_by?: string | null
          max_attempts?: number
          organization_id?: string
          payload?: Json
          priority?: number
          run_after?: string
          source_event_id?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "job_queue_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_queue_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      judge_alignment_pool: {
        Row: {
          added_at: string
          dataset: string
          dimension: string
          id: string
          organization_id: string
          trace_id: string
        }
        Insert: {
          added_at?: string
          dataset: string
          dimension: string
          id?: string
          organization_id: string
          trace_id: string
        }
        Update: {
          added_at?: string
          dataset?: string
          dimension?: string
          id?: string
          organization_id?: string
          trace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "judge_alignment_pool_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      lead_checkpoints: {
        Row: {
          commitments: Json
          contact_id: string
          created_at: string
          id: string
          job_id: string | null
          next_action: string | null
          objections: Json
          organization_id: string
          rolling_summary: string
          seq: number
        }
        Insert: {
          commitments?: Json
          contact_id: string
          created_at?: string
          id?: string
          job_id?: string | null
          next_action?: string | null
          objections?: Json
          organization_id: string
          rolling_summary?: string
          seq?: never
        }
        Update: {
          commitments?: Json
          contact_id?: string
          created_at?: string
          id?: string
          job_id?: string | null
          next_action?: string | null
          objections?: Json
          organization_id?: string
          rolling_summary?: string
          seq?: never
        }
        Relationships: [
          {
            foreignKeyName: "lead_checkpoints_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_checkpoints_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "job_queue"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_checkpoints_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      lead_notes: {
        Row: {
          body: string
          contact_id: string
          created_at: string
          embedding: Json | null
          headline: string
          id: string
          organization_id: string
          updated_at: string
        }
        Insert: {
          body: string
          contact_id: string
          created_at?: string
          embedding?: Json | null
          headline: string
          id?: string
          organization_id: string
          updated_at?: string
        }
        Update: {
          body?: string
          contact_id?: string
          created_at?: string
          embedding?: Json | null
          headline?: string
          id?: string
          organization_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "lead_notes_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_notes_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      lead_state: {
        Row: {
          contact_id: string
          id: string
          next_action: string | null
          organization_id: string
          qualification: Json
          stage: string
          updated_at: string
        }
        Insert: {
          contact_id: string
          id?: string
          next_action?: string | null
          organization_id: string
          qualification?: Json
          stage?: string
          updated_at?: string
        }
        Update: {
          contact_id?: string
          id?: string
          next_action?: string | null
          organization_id?: string
          qualification?: Json
          stage?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "lead_state_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_state_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      lead_state_transitions: {
        Row: {
          contact_id: string
          created_at: string
          from_stage: string
          id: string
          job_id: string | null
          organization_id: string
          reason: string | null
          seq: number
          to_stage: string
        }
        Insert: {
          contact_id: string
          created_at?: string
          from_stage: string
          id?: string
          job_id?: string | null
          organization_id: string
          reason?: string | null
          seq?: never
          to_stage: string
        }
        Update: {
          contact_id?: string
          created_at?: string
          from_stage?: string
          id?: string
          job_id?: string | null
          organization_id?: string
          reason?: string | null
          seq?: never
          to_stage?: string
        }
        Relationships: [
          {
            foreignKeyName: "lead_state_transitions_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_state_transitions_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "job_queue"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_state_transitions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      lgpd_requests: {
        Row: {
          attempts: number
          cascaded_to: Json | null
          completed_at: string | null
          contact_id: string | null
          created_at: string
          due_at: string
          emergency: boolean
          error_message: string | null
          external_customer_id: string | null
          id: string
          organization_id: string
          received_at: string
          request_payload: Json
          request_type: string
          result: Json | null
          scope: string
          source: string
          status: string
          updated_at: string
        }
        Insert: {
          attempts?: number
          cascaded_to?: Json | null
          completed_at?: string | null
          contact_id?: string | null
          created_at?: string
          due_at: string
          emergency?: boolean
          error_message?: string | null
          external_customer_id?: string | null
          id?: string
          organization_id: string
          received_at?: string
          request_payload?: Json
          request_type: string
          result?: Json | null
          scope?: string
          source: string
          status?: string
          updated_at?: string
        }
        Update: {
          attempts?: number
          cascaded_to?: Json | null
          completed_at?: string | null
          contact_id?: string | null
          created_at?: string
          due_at?: string
          emergency?: boolean
          error_message?: string | null
          external_customer_id?: string | null
          id?: string
          organization_id?: string
          received_at?: string
          request_payload?: Json
          request_type?: string
          result?: Json | null
          scope?: string
          source?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "lgpd_requests_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lgpd_requests_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      llm_calls: {
        Row: {
          cache_read_tokens: number
          cache_write_tokens: number
          contact_id: string | null
          cost_cents: number | null
          created_at: string
          id: string
          input_tokens: number
          job_id: string | null
          latency_ms: number | null
          model: string
          organization_id: string
          output_tokens: number
          provider: string
          purpose: string
          variant_id: string | null
        }
        Insert: {
          cache_read_tokens?: number
          cache_write_tokens?: number
          contact_id?: string | null
          cost_cents?: number | null
          created_at?: string
          id?: string
          input_tokens?: number
          job_id?: string | null
          latency_ms?: number | null
          model: string
          organization_id: string
          output_tokens?: number
          provider: string
          purpose?: string
          variant_id?: string | null
        }
        Update: {
          cache_read_tokens?: number
          cache_write_tokens?: number
          contact_id?: string | null
          cost_cents?: number | null
          created_at?: string
          id?: string
          input_tokens?: number
          job_id?: string | null
          latency_ms?: number | null
          model?: string
          organization_id?: string
          output_tokens?: number
          provider?: string
          purpose?: string
          variant_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "llm_calls_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "llm_calls_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "job_queue"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "llm_calls_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      merge_queue: {
        Row: {
          candidates: string[]
          created_at: string
          id: string
          organization_id: string
          reason: string
          resolution: Json | null
          resolved_at: string | null
          resolved_by_user_id: string | null
          status: string
          trigger_payload: Json
        }
        Insert: {
          candidates: string[]
          created_at?: string
          id?: string
          organization_id: string
          reason: string
          resolution?: Json | null
          resolved_at?: string | null
          resolved_by_user_id?: string | null
          status?: string
          trigger_payload?: Json
        }
        Update: {
          candidates?: string[]
          created_at?: string
          id?: string
          organization_id?: string
          reason?: string
          resolution?: Json | null
          resolved_at?: string | null
          resolved_by_user_id?: string | null
          status?: string
          trigger_payload?: Json
        }
        Relationships: [
          {
            foreignKeyName: "merge_queue_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      messages: {
        Row: {
          ack: number | null
          activity_id: string | null
          body: string | null
          channel_session_id: string
          contact_id: string
          conversation_id: string
          created_at: string
          delivered_at: string | null
          direction: string
          error_code: string | null
          error_message: string | null
          external_id: string | null
          id: string
          media_mime: string | null
          media_size_bytes: number | null
          media_storage_path: string | null
          media_url: string | null
          metadata: Json
          organization_id: string
          read_at: string | null
          sent_at: string
          sent_by_user_id: string | null
          sent_via: string
          status: string
          type: string
          updated_at: string
        }
        Insert: {
          ack?: number | null
          activity_id?: string | null
          body?: string | null
          channel_session_id: string
          contact_id: string
          conversation_id: string
          created_at?: string
          delivered_at?: string | null
          direction: string
          error_code?: string | null
          error_message?: string | null
          external_id?: string | null
          id?: string
          media_mime?: string | null
          media_size_bytes?: number | null
          media_storage_path?: string | null
          media_url?: string | null
          metadata?: Json
          organization_id: string
          read_at?: string | null
          sent_at?: string
          sent_by_user_id?: string | null
          sent_via?: string
          status?: string
          type: string
          updated_at?: string
        }
        Update: {
          ack?: number | null
          activity_id?: string | null
          body?: string | null
          channel_session_id?: string
          contact_id?: string
          conversation_id?: string
          created_at?: string
          delivered_at?: string | null
          direction?: string
          error_code?: string | null
          error_message?: string | null
          external_id?: string | null
          id?: string
          media_mime?: string | null
          media_size_bytes?: number | null
          media_storage_path?: string | null
          media_url?: string | null
          metadata?: Json
          organization_id?: string
          read_at?: string | null
          sent_at?: string
          sent_by_user_id?: string | null
          sent_via?: string
          status?: string
          type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "messages_activity_id_fkey"
            columns: ["activity_id"]
            isOneToOne: false
            referencedRelation: "crm_lead_activities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_channel_session_id_fkey"
            columns: ["channel_session_id"]
            isOneToOne: false
            referencedRelation: "channel_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      metrics: {
        Row: {
          created_at: string
          id: string
          labels: Json
          name: string
          organization_id: string | null
          value: number
        }
        Insert: {
          created_at?: string
          id?: string
          labels?: Json
          name: string
          organization_id?: string | null
          value: number
        }
        Update: {
          created_at?: string
          id?: string
          labels?: Json
          name?: string
          organization_id?: string | null
          value?: number
        }
        Relationships: [
          {
            foreignKeyName: "metrics_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      nuvemshop_products: {
        Row: {
          available_qty: number
          created_at: string
          description: string | null
          external_id: string
          id: string
          image_url: string | null
          last_updated_at: string
          organization_id: string
          payload: Json
          price_cents: number
          rag_chunk_count: number
          rag_indexed_at: string | null
          title: string
          updated_at: string
          url: string | null
        }
        Insert: {
          available_qty?: number
          created_at?: string
          description?: string | null
          external_id: string
          id?: string
          image_url?: string | null
          last_updated_at: string
          organization_id: string
          payload?: Json
          price_cents: number
          rag_chunk_count?: number
          rag_indexed_at?: string | null
          title: string
          updated_at?: string
          url?: string | null
        }
        Update: {
          available_qty?: number
          created_at?: string
          description?: string | null
          external_id?: string
          id?: string
          image_url?: string | null
          last_updated_at?: string
          organization_id?: string
          payload?: Json
          price_cents?: number
          rag_chunk_count?: number
          rag_indexed_at?: string | null
          title?: string
          updated_at?: string
          url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "nuvemshop_products_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      orders: {
        Row: {
          contact_id: string | null
          created_at: string
          currency: string
          customer_external_id: string | null
          external_id: string
          external_provider: string
          fulfillment_status: string | null
          id: string
          is_anonymized: boolean
          ordered_at: string
          organization_id: string
          payload: Json
          payment_method: string | null
          status: string
          total_cents: number
          tracking_code: string | null
          updated_at: string
          updated_at_remote: string | null
        }
        Insert: {
          contact_id?: string | null
          created_at?: string
          currency?: string
          customer_external_id?: string | null
          external_id: string
          external_provider: string
          fulfillment_status?: string | null
          id?: string
          is_anonymized?: boolean
          ordered_at: string
          organization_id: string
          payload?: Json
          payment_method?: string | null
          status: string
          total_cents: number
          tracking_code?: string | null
          updated_at?: string
          updated_at_remote?: string | null
        }
        Update: {
          contact_id?: string | null
          created_at?: string
          currency?: string
          customer_external_id?: string | null
          external_id?: string
          external_provider?: string
          fulfillment_status?: string | null
          id?: string
          is_anonymized?: boolean
          ordered_at?: string
          organization_id?: string
          payload?: Json
          payment_method?: string | null
          status?: string
          total_cents?: number
          tracking_code?: string | null
          updated_at?: string
          updated_at_remote?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "orders_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organizations: {
        Row: {
          ai_budget_cents: number | null
          cnpj: string | null
          created_at: string
          created_by: string | null
          display_name: string
          dpo_email: string | null
          id: string
          legal_name: string
          locale: string
          media_retention_days: number
          onboarded_at: string | null
          onboarding_state: Json
          privacy_policy_url: string | null
          rate_limit_rps: number
          redacted_at: string | null
          settings: Json
          slug: string
          status: string
          suspended_at: string | null
          suspended_by: string | null
          suspended_reason: string | null
          timezone: string
          updated_at: string
        }
        Insert: {
          ai_budget_cents?: number | null
          cnpj?: string | null
          created_at?: string
          created_by?: string | null
          display_name: string
          dpo_email?: string | null
          id?: string
          legal_name: string
          locale?: string
          media_retention_days?: number
          onboarded_at?: string | null
          onboarding_state?: Json
          privacy_policy_url?: string | null
          rate_limit_rps?: number
          redacted_at?: string | null
          settings?: Json
          slug: string
          status?: string
          suspended_at?: string | null
          suspended_by?: string | null
          suspended_reason?: string | null
          timezone?: string
          updated_at?: string
        }
        Update: {
          ai_budget_cents?: number | null
          cnpj?: string | null
          created_at?: string
          created_by?: string | null
          display_name?: string
          dpo_email?: string | null
          id?: string
          legal_name?: string
          locale?: string
          media_retention_days?: number
          onboarded_at?: string | null
          onboarding_state?: Json
          privacy_policy_url?: string | null
          rate_limit_rps?: number
          redacted_at?: string | null
          settings?: Json
          slug?: string
          status?: string
          suspended_at?: string | null
          suspended_by?: string | null
          suspended_reason?: string | null
          timezone?: string
          updated_at?: string
        }
        Relationships: []
      }
      outbound_copies: {
        Row: {
          channel_session_id: string
          id: string
          normalized_hash: string
          normalized_text: string
          organization_id: string
          sent_at: string
        }
        Insert: {
          channel_session_id: string
          id?: string
          normalized_hash: string
          normalized_text: string
          organization_id: string
          sent_at?: string
        }
        Update: {
          channel_session_id?: string
          id?: string
          normalized_hash?: string
          normalized_text?: string
          organization_id?: string
          sent_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "outbound_copies_channel_session_id_fkey"
            columns: ["channel_session_id"]
            isOneToOne: false
            referencedRelation: "channel_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "outbound_copies_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      pacing_ledger: {
        Row: {
          channel_session_id: string
          id: string
          organization_id: string
          sent_at: string
        }
        Insert: {
          channel_session_id: string
          id?: string
          organization_id: string
          sent_at?: string
        }
        Update: {
          channel_session_id?: string
          id?: string
          organization_id?: string
          sent_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pacing_ledger_channel_session_id_fkey"
            columns: ["channel_session_id"]
            isOneToOne: false
            referencedRelation: "channel_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pacing_ledger_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      platform_admins: {
        Row: {
          granted_at: string
          granted_by: string
          mfa_required: boolean
          reason: string
          revoke_reason: string | null
          revoked_at: string | null
          revoked_by: string | null
          scope: string
          user_id: string
        }
        Insert: {
          granted_at?: string
          granted_by: string
          mfa_required?: boolean
          reason: string
          revoke_reason?: string | null
          revoked_at?: string | null
          revoked_by?: string | null
          scope?: string
          user_id: string
        }
        Update: {
          granted_at?: string
          granted_by?: string
          mfa_required?: boolean
          reason?: string
          revoke_reason?: string | null
          revoked_at?: string | null
          revoked_by?: string | null
          scope?: string
          user_id?: string
        }
        Relationships: []
      }
      playbook_pointers: {
        Row: {
          layer: string
          organization_id: string | null
          updated_at: string
          version_id: string
        }
        Insert: {
          layer: string
          organization_id?: string | null
          updated_at?: string
          version_id: string
        }
        Update: {
          layer?: string
          organization_id?: string | null
          updated_at?: string
          version_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "playbook_pointers_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "playbook_pointers_version_id_fkey"
            columns: ["version_id"]
            isOneToOne: false
            referencedRelation: "playbook_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      playbook_versions: {
        Row: {
          content: string
          created_at: string
          id: string
          layer: string
          organization_id: string | null
        }
        Insert: {
          content: string
          created_at?: string
          id?: string
          layer: string
          organization_id?: string | null
        }
        Update: {
          content?: string
          created_at?: string
          id?: string
          layer?: string
          organization_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "playbook_versions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      promise_table_pointers: {
        Row: {
          organization_id: string
          updated_at: string
          version_id: string
        }
        Insert: {
          organization_id: string
          updated_at?: string
          version_id: string
        }
        Update: {
          organization_id?: string
          updated_at?: string
          version_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "promise_table_pointers_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "promise_table_pointers_version_id_fkey"
            columns: ["version_id"]
            isOneToOne: false
            referencedRelation: "promise_table_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      promise_table_versions: {
        Row: {
          created_at: string
          id: string
          organization_id: string
          values: Json
        }
        Insert: {
          created_at?: string
          id?: string
          organization_id: string
          values: Json
        }
        Update: {
          created_at?: string
          id?: string
          organization_id?: string
          values?: Json
        }
        Relationships: [
          {
            foreignKeyName: "promise_table_versions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      reentry_knob_pointers: {
        Row: {
          organization_id: string
          updated_at: string
          version_id: string
        }
        Insert: {
          organization_id: string
          updated_at?: string
          version_id: string
        }
        Update: {
          organization_id?: string
          updated_at?: string
          version_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "reentry_knob_pointers_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: true
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reentry_knob_pointers_version_id_fkey"
            columns: ["version_id"]
            isOneToOne: false
            referencedRelation: "reentry_knob_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      reentry_knob_versions: {
        Row: {
          created_at: string
          id: string
          knobs: Json
          organization_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          knobs: Json
          organization_id: string
        }
        Update: {
          created_at?: string
          id?: string
          knobs?: Json
          organization_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "reentry_knob_versions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      reentry_template_pointers: {
        Row: {
          organization_id: string
          updated_at: string
          version_id: string
        }
        Insert: {
          organization_id: string
          updated_at?: string
          version_id: string
        }
        Update: {
          organization_id?: string
          updated_at?: string
          version_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "reentry_template_pointers_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: true
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reentry_template_pointers_version_id_fkey"
            columns: ["version_id"]
            isOneToOne: false
            referencedRelation: "reentry_template_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      reentry_template_versions: {
        Row: {
          created_at: string
          id: string
          organization_id: string
          variants: string[]
        }
        Insert: {
          created_at?: string
          id?: string
          organization_id: string
          variants: string[]
        }
        Update: {
          created_at?: string
          id?: string
          organization_id?: string
          variants?: string[]
        }
        Relationships: [
          {
            foreignKeyName: "reentry_template_versions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      send_ledger: {
        Row: {
          body_hash: string
          contact_id: string | null
          created_at: string
          crm_message_id: string | null
          id: string
          job_id: string
          last_error: string | null
          organization_id: string
          seq: number
          status: string
          updated_at: string
        }
        Insert: {
          body_hash: string
          contact_id?: string | null
          created_at?: string
          crm_message_id?: string | null
          id?: string
          job_id: string
          last_error?: string | null
          organization_id: string
          seq: number
          status?: string
          updated_at?: string
        }
        Update: {
          body_hash?: string
          contact_id?: string | null
          created_at?: string
          crm_message_id?: string | null
          id?: string
          job_id?: string
          last_error?: string | null
          organization_id?: string
          seq?: number
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "send_ledger_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "send_ledger_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "job_queue"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "send_ledger_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      skill_pointers: {
        Row: {
          name: string
          organization_id: string | null
          updated_at: string
          version_id: string
        }
        Insert: {
          name: string
          organization_id?: string | null
          updated_at?: string
          version_id: string
        }
        Update: {
          name?: string
          organization_id?: string | null
          updated_at?: string
          version_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "skill_pointers_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "skill_pointers_version_id_fkey"
            columns: ["version_id"]
            isOneToOne: false
            referencedRelation: "skill_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      skill_versions: {
        Row: {
          body: string
          created_at: string
          description: string
          id: string
          matcher: Json
          name: string
          organization_id: string | null
        }
        Insert: {
          body: string
          created_at?: string
          description: string
          id?: string
          matcher?: Json
          name: string
          organization_id?: string | null
        }
        Update: {
          body?: string
          created_at?: string
          description?: string
          id?: string
          matcher?: Json
          name?: string
          organization_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "skill_versions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      storage_redaction_queue: {
        Row: {
          attempts: number
          bucket: string
          enqueued_at: string
          error_message: string | null
          id: string
          object_path: string
          organization_id: string
          processed_at: string | null
          request_id: string | null
          status: string
        }
        Insert: {
          attempts?: number
          bucket: string
          enqueued_at?: string
          error_message?: string | null
          id?: string
          object_path: string
          organization_id: string
          processed_at?: string | null
          request_id?: string | null
          status?: string
        }
        Update: {
          attempts?: number
          bucket?: string
          enqueued_at?: string
          error_message?: string | null
          id?: string
          object_path?: string
          organization_id?: string
          processed_at?: string | null
          request_id?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "storage_redaction_queue_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "storage_redaction_queue_request_id_fkey"
            columns: ["request_id"]
            isOneToOne: false
            referencedRelation: "lgpd_requests"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_integrations: {
        Row: {
          created_at: string
          expires_at: string | null
          id: string
          last_health_check_at: string | null
          last_sync_at: string | null
          oauth_access_token_encrypted: string
          oauth_refresh_token_encrypted: string | null
          organization_id: string
          provider: string
          scopes: string[]
          status: string
          status_reason: string | null
          store_metadata: Json
          updated_at: string
          webhook_path_token: string
          webhook_secret_encrypted: string
          webhook_subscriptions: Json
        }
        Insert: {
          created_at?: string
          expires_at?: string | null
          id?: string
          last_health_check_at?: string | null
          last_sync_at?: string | null
          oauth_access_token_encrypted: string
          oauth_refresh_token_encrypted?: string | null
          organization_id: string
          provider: string
          scopes?: string[]
          status?: string
          status_reason?: string | null
          store_metadata?: Json
          updated_at?: string
          webhook_path_token?: string
          webhook_secret_encrypted: string
          webhook_subscriptions?: Json
        }
        Update: {
          created_at?: string
          expires_at?: string | null
          id?: string
          last_health_check_at?: string | null
          last_sync_at?: string | null
          oauth_access_token_encrypted?: string
          oauth_refresh_token_encrypted?: string | null
          organization_id?: string
          provider?: string
          scopes?: string[]
          status?: string
          status_reason?: string | null
          store_metadata?: Json
          updated_at?: string
          webhook_path_token?: string
          webhook_secret_encrypted?: string
          webhook_subscriptions?: Json
        }
        Relationships: [
          {
            foreignKeyName: "tenant_integrations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      user_organizations: {
        Row: {
          accepted_at: string | null
          created_at: string
          id: string
          invited_at: string | null
          invited_by: string | null
          organization_id: string
          revoked_at: string | null
          role: string
          updated_at: string
          user_id: string
        }
        Insert: {
          accepted_at?: string | null
          created_at?: string
          id?: string
          invited_at?: string | null
          invited_by?: string | null
          organization_id: string
          revoked_at?: string | null
          role: string
          updated_at?: string
          user_id: string
        }
        Update: {
          accepted_at?: string | null
          created_at?: string
          id?: string
          invited_at?: string | null
          invited_by?: string | null
          organization_id?: string
          revoked_at?: string | null
          role?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_organizations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      user_recovery_codes: {
        Row: {
          code_hash: string
          created_at: string
          id: string
          used_at: string | null
          used_ip: unknown
          user_id: string
        }
        Insert: {
          code_hash: string
          created_at?: string
          id?: string
          used_at?: string | null
          used_ip?: unknown
          user_id: string
        }
        Update: {
          code_hash?: string
          created_at?: string
          id?: string
          used_at?: string | null
          used_ip?: unknown
          user_id?: string
        }
        Relationships: []
      }
      watchdog_cursors: {
        Row: {
          consumer: string
          last_created_at: string
          last_event_id: string
          updated_at: string
        }
        Insert: {
          consumer: string
          last_created_at?: string
          last_event_id?: string
          updated_at?: string
        }
        Update: {
          consumer?: string
          last_created_at?: string
          last_event_id?: string
          updated_at?: string
        }
        Relationships: []
      }
      webhook_events_log: {
        Row: {
          archived_at: string | null
          attempts: number
          channel_session_id: string | null
          error_message: string | null
          event_type: string | null
          external_id: string | null
          headers: Json | null
          http_method: string
          id: string
          organization_id: string | null
          payload_parsed: Json | null
          processed_at: string | null
          provider: string
          raw_body: string
          received_at: string
          signature_header: string | null
          status: string
          valid_signature: boolean | null
          webhook_path_token: string | null
        }
        Insert: {
          archived_at?: string | null
          attempts?: number
          channel_session_id?: string | null
          error_message?: string | null
          event_type?: string | null
          external_id?: string | null
          headers?: Json | null
          http_method?: string
          id?: string
          organization_id?: string | null
          payload_parsed?: Json | null
          processed_at?: string | null
          provider?: string
          raw_body: string
          received_at?: string
          signature_header?: string | null
          status?: string
          valid_signature?: boolean | null
          webhook_path_token?: string | null
        }
        Update: {
          archived_at?: string | null
          attempts?: number
          channel_session_id?: string | null
          error_message?: string | null
          event_type?: string | null
          external_id?: string | null
          headers?: Json | null
          http_method?: string
          id?: string
          organization_id?: string | null
          payload_parsed?: Json | null
          processed_at?: string | null
          provider?: string
          raw_body?: string
          received_at?: string
          signature_header?: string | null
          status?: string
          valid_signature?: boolean | null
          webhook_path_token?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "webhook_events_log_channel_session_id_fkey"
            columns: ["channel_session_id"]
            isOneToOne: false
            referencedRelation: "channel_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      webhook_sources: {
        Row: {
          created_at: string
          created_by_user_id: string | null
          default_pipeline_id: string
          default_stage_id: string
          field_map: Json
          id: string
          is_active: boolean
          kind: string
          last_received_at: string | null
          name: string
          organization_id: string
          path_token: string
          redirect_to: string | null
          secret_encrypted: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by_user_id?: string | null
          default_pipeline_id: string
          default_stage_id: string
          field_map?: Json
          id?: string
          is_active?: boolean
          kind?: string
          last_received_at?: string | null
          name: string
          organization_id: string
          path_token: string
          redirect_to?: string | null
          secret_encrypted?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by_user_id?: string | null
          default_pipeline_id?: string
          default_stage_id?: string
          field_map?: Json
          id?: string
          is_active?: boolean
          kind?: string
          last_received_at?: string | null
          name?: string
          organization_id?: string
          path_token?: string
          redirect_to?: string | null
          secret_encrypted?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "webhook_sources_default_pipeline_id_fkey"
            columns: ["default_pipeline_id"]
            isOneToOne: false
            referencedRelation: "crm_pipelines"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "webhook_sources_default_stage_id_fkey"
            columns: ["default_stage_id"]
            isOneToOne: false
            referencedRelation: "crm_stages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "webhook_sources_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      ai_provider_credentials_safe: {
        Row: {
          api_key_last4: string | null
          created_at: string | null
          created_by: string | null
          id: string | null
          is_active: boolean | null
          label: string | null
          models_available: string[] | null
          organization_id: string | null
          provider: string | null
          updated_at: string | null
          validated_at: string | null
          validation_error: string | null
        }
        Insert: {
          api_key_last4?: string | null
          created_at?: string | null
          created_by?: string | null
          id?: string | null
          is_active?: boolean | null
          label?: string | null
          models_available?: string[] | null
          organization_id?: string | null
          provider?: string | null
          updated_at?: string | null
          validated_at?: string | null
          validation_error?: string | null
        }
        Update: {
          api_key_last4?: string | null
          created_at?: string | null
          created_by?: string | null
          id?: string | null
          is_active?: boolean | null
          label?: string | null
          models_available?: string[] | null
          organization_id?: string | null
          provider?: string | null
          updated_at?: string | null
          validated_at?: string | null
          validation_error?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ai_provider_credentials_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      activate_kb_version: {
        Args: { p_agent_id: string; p_version_id: string }
        Returns: undefined
      }
      emit_event: {
        Args: {
          p_entity_id: string
          p_entity_kind: string
          p_event_type: string
          p_metadata?: Json
          p_organization_id?: string
          p_payload?: Json
        }
        Returns: string
      }
      fn_attendant_metrics: {
        Args: { p_from: string; p_org: string; p_owner?: string; p_to: string }
        Returns: Json
      }
      fn_can_view_conversation: {
        Args: { p_assigned_to_user_id: string; p_org: string }
        Returns: boolean
      }
      fn_can_view_lead: {
        Args: { p_org: string; p_owner_user_id: string }
        Returns: boolean
      }
      fn_conversation_assign: {
        Args: {
          p_conversation_id: string
          p_enforce_expected?: boolean
          p_expected_assignee?: string
          p_organization_id: string
          p_reason: string
          p_to_user_id: string
        }
        Returns: {
          assigned_at: string | null
          assigned_to_user_id: string | null
          assignee_kind: string | null
          bot_silenced_until: string | null
          channel: string
          channel_session_id: string
          contact_id: string
          created_at: string
          group_chat_id: string | null
          id: string
          is_group: boolean
          last_handoff_at: string | null
          last_handoff_reason: string | null
          last_inbound_at: string | null
          last_message_at: string | null
          last_message_preview: string | null
          last_outbound_at: string | null
          metadata: Json
          organization_id: string
          rag_review_status: string | null
          status: string
          status_changed_at: string
          tags: string[]
          unread_count_for_assignee: number
          updated_at: string
          usable_for_rag: boolean
          usable_for_rag_marked_at: string | null
          usable_for_rag_marked_by: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "conversations"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      fn_decrypt_oauth: { Args: { ciphertext: string }; Returns: string }
      fn_encrypt_oauth: { Args: { plaintext: string }; Returns: string }
      fn_is_platform_admin: { Args: never; Returns: boolean }
      fn_lgpd_cascade_redact_contact: {
        Args: {
          p_contact_id: string
          p_organization_id: string
          p_request_id: string
        }
        Returns: Json
      }
      fn_log_event: {
        Args: {
          p_event_type: string
          p_organization_id: string
          p_payload?: Json
        }
        Returns: string
      }
      fn_mark_conversation_message: {
        Args: {
          p_at: string
          p_conv: string
          p_direction: string
          p_preview: string
        }
        Returns: undefined
      }
      fn_member_role_in_org: {
        Args: { p_org: string; p_user: string }
        Returns: string
      }
      fn_publish_ai_agent_version: {
        Args: { p_agent_id: string; p_org_id: string; p_version_id: string }
        Returns: {
          agent_id: string
          previous_version_id: string
          published_at: string
          version_id: string
        }[]
      }
      fn_role_at_least: {
        Args: { p_min: string; p_org: string }
        Returns: boolean
      }
      fn_upsert_wa_contact: {
        Args: {
          p_chat_id: string
          p_kind: string
          p_lid: string
          p_notify: string
          p_org: string
          p_phone: string
        }
        Returns: string
      }
      fn_upsert_wa_conversation: {
        Args: { p_contact: string; p_org: string; p_session: string }
        Returns: string
      }
      fn_user_org_ids: { Args: never; Returns: string[] }
      fn_user_role_in: { Args: { p_org: string }; Returns: number }
      fn_user_role_in_org: { Args: { p_org: string }; Returns: string }
      midpoint: { Args: { p_next: number; p_prev: number }; Returns: number }
      retrieve_top_k_chunks: {
        Args: {
          p_embedding: string
          p_k?: number
          p_kb_version_id: string
          p_organization_id: string
          p_threshold?: number
        }
        Returns: {
          chunk_id: string
          content: string
          knowledge_source_id: string
          metadata: Json
          similarity: number
        }[]
      }
      show_limit: { Args: never; Returns: number }
      show_trgm: { Args: { "": string }; Returns: string[] }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  storage: {
    Tables: {
      buckets: {
        Row: {
          allowed_mime_types: string[] | null
          avif_autodetection: boolean | null
          created_at: string | null
          file_size_limit: number | null
          id: string
          name: string
          owner: string | null
          owner_id: string | null
          public: boolean | null
          type: Database["storage"]["Enums"]["buckettype"]
          updated_at: string | null
        }
        Insert: {
          allowed_mime_types?: string[] | null
          avif_autodetection?: boolean | null
          created_at?: string | null
          file_size_limit?: number | null
          id: string
          name: string
          owner?: string | null
          owner_id?: string | null
          public?: boolean | null
          type?: Database["storage"]["Enums"]["buckettype"]
          updated_at?: string | null
        }
        Update: {
          allowed_mime_types?: string[] | null
          avif_autodetection?: boolean | null
          created_at?: string | null
          file_size_limit?: number | null
          id?: string
          name?: string
          owner?: string | null
          owner_id?: string | null
          public?: boolean | null
          type?: Database["storage"]["Enums"]["buckettype"]
          updated_at?: string | null
        }
        Relationships: []
      }
      buckets_analytics: {
        Row: {
          created_at: string
          deleted_at: string | null
          format: string
          id: string
          name: string
          type: Database["storage"]["Enums"]["buckettype"]
          updated_at: string
        }
        Insert: {
          created_at?: string
          deleted_at?: string | null
          format?: string
          id?: string
          name: string
          type?: Database["storage"]["Enums"]["buckettype"]
          updated_at?: string
        }
        Update: {
          created_at?: string
          deleted_at?: string | null
          format?: string
          id?: string
          name?: string
          type?: Database["storage"]["Enums"]["buckettype"]
          updated_at?: string
        }
        Relationships: []
      }
      buckets_vectors: {
        Row: {
          created_at: string
          id: string
          type: Database["storage"]["Enums"]["buckettype"]
          updated_at: string
        }
        Insert: {
          created_at?: string
          id: string
          type?: Database["storage"]["Enums"]["buckettype"]
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          type?: Database["storage"]["Enums"]["buckettype"]
          updated_at?: string
        }
        Relationships: []
      }
      migrations: {
        Row: {
          executed_at: string | null
          hash: string
          id: number
          name: string
        }
        Insert: {
          executed_at?: string | null
          hash: string
          id: number
          name: string
        }
        Update: {
          executed_at?: string | null
          hash?: string
          id?: number
          name?: string
        }
        Relationships: []
      }
      objects: {
        Row: {
          bucket_id: string | null
          created_at: string | null
          id: string
          last_accessed_at: string | null
          metadata: Json | null
          name: string | null
          owner: string | null
          owner_id: string | null
          path_tokens: string[] | null
          updated_at: string | null
          user_metadata: Json | null
          version: string | null
        }
        Insert: {
          bucket_id?: string | null
          created_at?: string | null
          id?: string
          last_accessed_at?: string | null
          metadata?: Json | null
          name?: string | null
          owner?: string | null
          owner_id?: string | null
          path_tokens?: string[] | null
          updated_at?: string | null
          user_metadata?: Json | null
          version?: string | null
        }
        Update: {
          bucket_id?: string | null
          created_at?: string | null
          id?: string
          last_accessed_at?: string | null
          metadata?: Json | null
          name?: string | null
          owner?: string | null
          owner_id?: string | null
          path_tokens?: string[] | null
          updated_at?: string | null
          user_metadata?: Json | null
          version?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "objects_bucketId_fkey"
            columns: ["bucket_id"]
            isOneToOne: false
            referencedRelation: "buckets"
            referencedColumns: ["id"]
          },
        ]
      }
      s3_multipart_uploads: {
        Row: {
          bucket_id: string
          created_at: string
          id: string
          in_progress_size: number
          key: string
          metadata: Json | null
          owner_id: string | null
          upload_signature: string
          user_metadata: Json | null
          version: string
        }
        Insert: {
          bucket_id: string
          created_at?: string
          id: string
          in_progress_size?: number
          key: string
          metadata?: Json | null
          owner_id?: string | null
          upload_signature: string
          user_metadata?: Json | null
          version: string
        }
        Update: {
          bucket_id?: string
          created_at?: string
          id?: string
          in_progress_size?: number
          key?: string
          metadata?: Json | null
          owner_id?: string | null
          upload_signature?: string
          user_metadata?: Json | null
          version?: string
        }
        Relationships: [
          {
            foreignKeyName: "s3_multipart_uploads_bucket_id_fkey"
            columns: ["bucket_id"]
            isOneToOne: false
            referencedRelation: "buckets"
            referencedColumns: ["id"]
          },
        ]
      }
      s3_multipart_uploads_parts: {
        Row: {
          bucket_id: string
          created_at: string
          etag: string
          id: string
          key: string
          owner_id: string | null
          part_number: number
          size: number
          upload_id: string
          version: string
        }
        Insert: {
          bucket_id: string
          created_at?: string
          etag: string
          id?: string
          key: string
          owner_id?: string | null
          part_number: number
          size?: number
          upload_id: string
          version: string
        }
        Update: {
          bucket_id?: string
          created_at?: string
          etag?: string
          id?: string
          key?: string
          owner_id?: string | null
          part_number?: number
          size?: number
          upload_id?: string
          version?: string
        }
        Relationships: [
          {
            foreignKeyName: "s3_multipart_uploads_parts_bucket_id_fkey"
            columns: ["bucket_id"]
            isOneToOne: false
            referencedRelation: "buckets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "s3_multipart_uploads_parts_upload_id_fkey"
            columns: ["upload_id"]
            isOneToOne: false
            referencedRelation: "s3_multipart_uploads"
            referencedColumns: ["id"]
          },
        ]
      }
      vector_indexes: {
        Row: {
          bucket_id: string
          created_at: string
          data_type: string
          dimension: number
          distance_metric: string
          id: string
          metadata_configuration: Json | null
          name: string
          updated_at: string
        }
        Insert: {
          bucket_id: string
          created_at?: string
          data_type: string
          dimension: number
          distance_metric: string
          id?: string
          metadata_configuration?: Json | null
          name: string
          updated_at?: string
        }
        Update: {
          bucket_id?: string
          created_at?: string
          data_type?: string
          dimension?: number
          distance_metric?: string
          id?: string
          metadata_configuration?: Json | null
          name?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "vector_indexes_bucket_id_fkey"
            columns: ["bucket_id"]
            isOneToOne: false
            referencedRelation: "buckets_vectors"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      allow_any_operation: {
        Args: { expected_operations: string[] }
        Returns: boolean
      }
      allow_only_operation: {
        Args: { expected_operation: string }
        Returns: boolean
      }
      can_insert_object: {
        Args: { bucketid: string; metadata: Json; name: string; owner: string }
        Returns: undefined
      }
      extension: { Args: { name: string }; Returns: string }
      filename: { Args: { name: string }; Returns: string }
      foldername: { Args: { name: string }; Returns: string[] }
      get_common_prefix: {
        Args: { p_delimiter: string; p_key: string; p_prefix: string }
        Returns: string
      }
      get_size_by_bucket: {
        Args: never
        Returns: {
          bucket_id: string
          size: number
        }[]
      }
      list_multipart_uploads_with_delimiter: {
        Args: {
          bucket_id: string
          delimiter_param: string
          max_keys?: number
          next_key_token?: string
          next_upload_token?: string
          prefix_param: string
        }
        Returns: {
          created_at: string
          id: string
          key: string
        }[]
      }
      list_objects_with_delimiter: {
        Args: {
          _bucket_id: string
          delimiter_param: string
          max_keys?: number
          next_token?: string
          prefix_param: string
          sort_order?: string
          start_after?: string
        }
        Returns: {
          created_at: string
          id: string
          last_accessed_at: string
          metadata: Json
          name: string
          updated_at: string
        }[]
      }
      operation: { Args: never; Returns: string }
      search: {
        Args: {
          bucketname: string
          levels?: number
          limits?: number
          offsets?: number
          prefix: string
          search?: string
          sortcolumn?: string
          sortorder?: string
        }
        Returns: {
          created_at: string
          id: string
          last_accessed_at: string
          metadata: Json
          name: string
          updated_at: string
        }[]
      }
      search_by_timestamp: {
        Args: {
          p_bucket_id: string
          p_level: number
          p_limit: number
          p_prefix: string
          p_sort_column: string
          p_sort_column_after: string
          p_sort_order: string
          p_start_after: string
        }
        Returns: {
          created_at: string
          id: string
          key: string
          last_accessed_at: string
          metadata: Json
          name: string
          updated_at: string
        }[]
      }
      search_v2: {
        Args: {
          bucket_name: string
          levels?: number
          limits?: number
          prefix: string
          sort_column?: string
          sort_column_after?: string
          sort_order?: string
          start_after?: string
        }
        Returns: {
          created_at: string
          id: string
          key: string
          last_accessed_at: string
          metadata: Json
          name: string
          updated_at: string
        }[]
      }
    }
    Enums: {
      buckettype: "STANDARD" | "ANALYTICS" | "VECTOR"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
  storage: {
    Enums: {
      buckettype: ["STANDARD", "ANALYTICS", "VECTOR"],
    },
  },
} as const
