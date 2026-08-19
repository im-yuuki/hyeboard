CREATE TABLE IF NOT EXISTS hyeboard_vnu_refresh_principals (
  principal_key text PRIMARY KEY,
  active_access_token_id text,
  active_access_expires_at_ms bigint,
  active_grant_id text,
  active_grant_expires_at_ms bigint,
  lease_expires_at_ms bigint,
  refresh_attempt_count integer NOT NULL,
  refresh_window_reset_at_ms bigint NOT NULL,
  activation_count integer,
  activation_window_reset_at_ms bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vnu_refresh_principals_key_format CHECK (principal_key ~ '^[0-9a-f]{64}$'),
  CONSTRAINT vnu_refresh_principals_active_pair CHECK (
    (active_access_token_id IS NULL AND active_access_expires_at_ms IS NULL AND active_grant_id IS NULL AND active_grant_expires_at_ms IS NULL)
    OR (active_access_token_id IS NOT NULL AND active_access_expires_at_ms IS NOT NULL AND active_grant_id IS NOT NULL AND active_grant_expires_at_ms IS NOT NULL)
  ),
  CONSTRAINT vnu_refresh_principals_lease_requires_active CHECK (
    lease_expires_at_ms IS NULL OR active_access_token_id IS NOT NULL
  ),
  CONSTRAINT vnu_refresh_principals_count_bounds CHECK (
    refresh_attempt_count BETWEEN 0 AND 5
    AND (activation_count IS NULL OR activation_count BETWEEN 1 AND 5)
  )
);

CREATE TABLE IF NOT EXISTS hyeboard_vnu_refresh_tombstones (
  principal_key text NOT NULL REFERENCES hyeboard_vnu_refresh_principals(principal_key) ON DELETE CASCADE,
  tombstone_kind text NOT NULL,
  tombstone_id text NOT NULL,
  expires_at_ms bigint NOT NULL,
  linked_access_token_id text,
  linked_access_expires_at_ms bigint,
  linked_grant_expires_at_ms bigint,
  successor_access_token_id text,
  successor_access_expires_at_ms bigint,
  successor_grant_id text,
  successor_grant_expires_at_ms bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (principal_key, tombstone_kind, tombstone_id),
  CONSTRAINT vnu_refresh_tombstones_kind CHECK (tombstone_kind IN ('access', 'grant')),
  CONSTRAINT vnu_refresh_tombstones_linkage CHECK (
    (tombstone_kind = 'access'
      AND linked_access_token_id IS NULL
      AND linked_access_expires_at_ms IS NULL
      AND linked_grant_expires_at_ms IS NULL
      AND successor_access_token_id IS NULL
      AND successor_access_expires_at_ms IS NULL
      AND successor_grant_id IS NULL
      AND successor_grant_expires_at_ms IS NULL)
    OR (tombstone_kind = 'grant'
      AND linked_access_token_id IS NOT NULL
      AND linked_access_expires_at_ms IS NOT NULL
      AND linked_grant_expires_at_ms IS NOT NULL
      AND ((successor_access_token_id IS NULL AND successor_access_expires_at_ms IS NULL AND successor_grant_id IS NULL AND successor_grant_expires_at_ms IS NULL)
        OR (successor_access_token_id IS NOT NULL AND successor_access_expires_at_ms IS NOT NULL AND successor_grant_id IS NOT NULL AND successor_grant_expires_at_ms IS NOT NULL)))
  )
);

CREATE INDEX IF NOT EXISTS hyeboard_vnu_refresh_tombstones_expiry_idx
  ON hyeboard_vnu_refresh_tombstones (expires_at_ms);

CREATE TABLE IF NOT EXISTS hyeboard_session_revocations (
  subject_kind text NOT NULL,
  subject_hash text NOT NULL,
  expires_at_ms bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (subject_kind, subject_hash),
  CONSTRAINT hyeboard_session_revocations_kind CHECK (subject_kind IN ('token', 'session')),
  CONSTRAINT hyeboard_session_revocations_hash_format CHECK (subject_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS hyeboard_session_revocations_expiry_idx
  ON hyeboard_session_revocations (expires_at_ms);
