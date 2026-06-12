-- Edge registry projection refresh (architecture §7): any change to the apps
-- table pings the 'helix_registry_changed' channel; the edge LISTENs and
-- reloads its full projection on notify (apps/edge/src/registry/listener.ts
-- duplicates the channel name — keep them in sync).
--
-- Trigger on `apps` only — no `versions` trigger needed: everything the
-- projection reads from `versions` is reached via apps."currentVersionId",
-- `blobPrefix` is immutable, and every pointer flip (setLiveVersion) updates
-- the apps row in the same transaction, which fires this trigger. The edge's
-- periodic reconcile covers any future drift.
--
-- Statement-level: the edge does a full reload, so one ping per statement is
-- enough. NOTIFY delivers on COMMIT, so the edge never sees uncommitted state.
CREATE OR REPLACE FUNCTION helix_registry_notify() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('helix_registry_changed', TG_TABLE_NAME);
  RETURN NULL;
END;
$$;

CREATE TRIGGER apps_registry_notify
AFTER INSERT OR UPDATE OR DELETE ON apps
FOR EACH STATEMENT EXECUTE FUNCTION helix_registry_notify();
