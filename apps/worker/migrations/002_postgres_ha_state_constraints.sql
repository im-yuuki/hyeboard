ALTER TABLE hyeboard_vnu_refresh_principals
  ADD CONSTRAINT vnu_refresh_principals_active_shape CHECK (
    (active_access_token_id IS NULL AND active_access_expires_at_ms IS NULL AND active_grant_id IS NULL AND active_grant_expires_at_ms IS NULL)
    OR (active_access_token_id IS NOT NULL
      AND active_access_token_id ~ '^[A-Za-z0-9_-]{22}$'
      AND active_access_expires_at_ms IS NOT NULL
      AND active_access_expires_at_ms > 0
      AND active_grant_id IS NOT NULL
      AND active_grant_id ~ '^[A-Za-z0-9_-]{22}$'
      AND active_grant_expires_at_ms IS NOT NULL
      AND active_grant_expires_at_ms > 0)
  ),
  ADD CONSTRAINT vnu_refresh_principals_lease_shape CHECK (
    lease_expires_at_ms IS NULL OR (lease_expires_at_ms > 0 AND active_access_token_id IS NOT NULL)
  ),
  ADD CONSTRAINT vnu_refresh_principals_window_shape CHECK (refresh_window_reset_at_ms > 0),
  ADD CONSTRAINT vnu_refresh_principals_activation_shape CHECK (
    (activation_count IS NULL AND activation_window_reset_at_ms IS NULL)
    OR (activation_count IS NOT NULL AND activation_window_reset_at_ms IS NOT NULL AND activation_count BETWEEN 1 AND 5 AND activation_window_reset_at_ms > 0)
  );

ALTER TABLE hyeboard_vnu_refresh_tombstones
  ADD CONSTRAINT vnu_refresh_tombstones_id_format CHECK (tombstone_id ~ '^[A-Za-z0-9_-]{22}$'),
  ADD CONSTRAINT vnu_refresh_tombstones_expiry_positive CHECK (expires_at_ms > 0),
  ADD CONSTRAINT vnu_refresh_tombstones_linked_shape CHECK (
    tombstone_kind = 'access'
    OR (linked_access_token_id IS NOT NULL
      AND linked_access_token_id ~ '^[A-Za-z0-9_-]{22}$'
      AND linked_access_expires_at_ms IS NOT NULL
      AND linked_access_expires_at_ms > 0
      AND linked_grant_expires_at_ms IS NOT NULL
      AND linked_grant_expires_at_ms > 0)
  ),
  ADD CONSTRAINT vnu_refresh_tombstones_successor_shape CHECK (
    (successor_access_token_id IS NULL AND successor_access_expires_at_ms IS NULL AND successor_grant_id IS NULL AND successor_grant_expires_at_ms IS NULL)
    OR (successor_access_token_id IS NOT NULL
      AND successor_access_token_id ~ '^[A-Za-z0-9_-]{22}$'
      AND successor_access_expires_at_ms IS NOT NULL
      AND successor_access_expires_at_ms > 0
      AND successor_grant_id IS NOT NULL
      AND successor_grant_id ~ '^[A-Za-z0-9_-]{22}$'
      AND successor_grant_expires_at_ms IS NOT NULL
      AND successor_grant_expires_at_ms > 0)
  );

ALTER TABLE hyeboard_session_revocations
  ADD CONSTRAINT hyeboard_session_revocations_expiry_positive CHECK (expires_at_ms > 0);
