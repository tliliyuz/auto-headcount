ALTER TABLE "audit_logs" ADD COLUMN "ip_address" text;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_audit_logs"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'audit_logs is append-only: updates are not allowed';
  END IF;
  IF TG_OP = 'DELETE'
     AND COALESCE(NULLIF(current_setting('app.audit_retention', true), ''), 'off') <> 'on' THEN
    RAISE EXCEPTION 'audit_logs deletion requires app.audit_retention=on (retention task only)';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "audit_logs_no_modify"
BEFORE UPDATE OR DELETE ON "audit_logs"
FOR EACH ROW EXECUTE FUNCTION "guard_audit_logs"();