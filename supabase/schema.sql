-- SmartLead EMAIL_SENT webhook capture schema
-- Apply via Supabase SQL editor or supabase-cli migrations.
--
-- Design notes:
--  * email_sent_events.event_hash is the unique dedupe key, so re-deliveries become
--    no-ops rather than duplicate rows. We never store the raw payload here, only
--    the B2 location and a body_preview capped at 500 chars.
--  * daily_counts and campaign_daily_counts are updated via RPCs (see below) so
--    concurrent webhook bursts can't lose increments to a read-modify-write race.
--  * webhook_processing_errors is the safety net. The Trigger.dev task never
--    swallows an error silently — if it can't reach Supabase it still fails the
--    task run, and if it reaches Supabase but the original write failed it
--    records the error here for later inspection.

-- ============================================================================
-- 1) email_sent_events
-- ============================================================================
create table if not exists public.email_sent_events (
  id bigserial primary key,
  event_hash text unique not null,
  event_type text not null default 'EMAIL_SENT',
  event_timestamp timestamptz,
  received_at timestamptz not null,
  client_id text,
  webhook_id text,
  webhook_name text,
  stats_id text,
  sl_email_lead_id text,
  sl_email_lead_map_id text,
  campaign_id text,
  campaign_name text,
  campaign_status text,
  sequence_number integer,
  from_email text,
  from_domain text,
  to_email text,
  to_domain text,
  to_name text,
  subject text,
  sent_message_id text,
  body_preview text,
  app_url text,
  b2_bucket text not null,
  b2_key text not null,
  raw_payload_sha256 text,
  created_at timestamptz not null default now()
);

-- Indexes — designed for dashboard-style queries.
create unique index if not exists email_sent_events_event_hash_key
  on public.email_sent_events (event_hash);
create index if not exists email_sent_events_event_timestamp_idx
  on public.email_sent_events (event_timestamp desc);
create index if not exists email_sent_events_to_email_idx
  on public.email_sent_events (to_email);
create index if not exists email_sent_events_from_email_idx
  on public.email_sent_events (from_email);
create index if not exists email_sent_events_campaign_id_idx
  on public.email_sent_events (campaign_id);
create index if not exists email_sent_events_client_id_idx
  on public.email_sent_events (client_id);
create index if not exists email_sent_events_sent_message_id_idx
  on public.email_sent_events (sent_message_id);
create index if not exists email_sent_events_campaign_id_event_timestamp_idx
  on public.email_sent_events (campaign_id, event_timestamp desc);
create index if not exists email_sent_events_client_id_event_timestamp_idx
  on public.email_sent_events (client_id, event_timestamp desc);

-- ============================================================================
-- 2) webhook_processing_errors
-- ============================================================================
create table if not exists public.webhook_processing_errors (
  id bigserial primary key,
  event_hash text,
  event_type text,
  error_stage text not null,
  error_message text not null,
  error_stack text,
  sample_payload jsonb,
  created_at timestamptz not null default now()
);

create index if not exists webhook_processing_errors_created_at_idx
  on public.webhook_processing_errors (created_at desc);
create index if not exists webhook_processing_errors_stage_idx
  on public.webhook_processing_errors (error_stage);
create index if not exists webhook_processing_errors_event_hash_idx
  on public.webhook_processing_errors (event_hash);

-- ============================================================================
-- 3) daily_counts
-- ============================================================================
create table if not exists public.daily_counts (
  event_date date not null,
  event_type text not null,
  count bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (event_date, event_type)
);

-- ============================================================================
-- 4) campaign_daily_counts
-- ============================================================================
create table if not exists public.campaign_daily_counts (
  event_date date not null,
  campaign_id text not null,
  campaign_name text,
  client_id text,
  event_type text not null,
  count bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (event_date, campaign_id, event_type)
);

create index if not exists campaign_daily_counts_client_id_idx
  on public.campaign_daily_counts (client_id);
create index if not exists campaign_daily_counts_event_date_idx
  on public.campaign_daily_counts (event_date desc);

-- ============================================================================
-- Atomic increment RPCs
-- These do the upsert in a single SQL statement so concurrent writers
-- don't lose increments to a read-modify-write race.
-- ============================================================================
create or replace function public.bump_daily_counts(
  p_event_date date,
  p_event_type text,
  p_increment bigint
) returns void
language plpgsql
as $$
begin
  insert into public.daily_counts (event_date, event_type, count, updated_at)
  values (p_event_date, p_event_type, p_increment, now())
  on conflict (event_date, event_type)
  do update set
    count = public.daily_counts.count + excluded.count,
    updated_at = now();
end;
$$;

create or replace function public.bump_campaign_daily_counts(
  p_event_date date,
  p_event_type text,
  p_campaign_id text,
  p_campaign_name text,
  p_client_id text,
  p_increment bigint
) returns void
language plpgsql
as $$
begin
  insert into public.campaign_daily_counts
    (event_date, campaign_id, campaign_name, client_id, event_type, count, updated_at)
  values
    (p_event_date, p_campaign_id, p_campaign_name, p_client_id, p_event_type, p_increment, now())
  on conflict (event_date, campaign_id, event_type)
  do update set
    campaign_name = coalesce(excluded.campaign_name, public.campaign_daily_counts.campaign_name),
    client_id = coalesce(excluded.client_id, public.campaign_daily_counts.client_id),
    count = public.campaign_daily_counts.count + excluded.count,
    updated_at = now();
end;
$$;
