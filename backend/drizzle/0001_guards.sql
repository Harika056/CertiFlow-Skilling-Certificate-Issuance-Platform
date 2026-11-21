-- Defence in depth: rules that must hold even if application code has a bug.

-- 1. The audit log is append-only. Nobody (including the app) can rewrite history.
CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
--> statement-breakpoint

-- 2. A revoked certificate can never become valid again, and its identity
--    (number, code, holder) can never be edited after issue.
CREATE OR REPLACE FUNCTION certificate_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'REVOKED' AND NEW.status <> 'REVOKED' THEN
    RAISE EXCEPTION 'certificate % is revoked and cannot be reinstated', OLD.cert_number;
  END IF;
  IF NEW.cert_number <> OLD.cert_number
     OR NEW.verification_code <> OLD.verification_code
     OR NEW.candidate_id <> OLD.candidate_id
     OR NEW.holder_name <> OLD.holder_name THEN
    RAISE EXCEPTION 'certificate identity fields are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER certificate_guard BEFORE UPDATE ON certificates
  FOR EACH ROW EXECUTE FUNCTION certificate_guard();
