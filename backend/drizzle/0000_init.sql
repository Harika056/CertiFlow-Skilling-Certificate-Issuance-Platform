CREATE TYPE "public"."batch_status" AS ENUM('DRAFT', 'DISTRICT_REVIEW', 'QUALITY_REVIEW', 'STATE_REVIEW', 'RETURNED', 'REJECTED', 'APPROVED', 'ISSUED');--> statement-breakpoint
CREATE TYPE "public"."certificate_status" AS ENUM('VALID', 'REVOKED');--> statement-breakpoint
CREATE TYPE "public"."decision" AS ENUM('APPROVE', 'REJECT', 'RETURN');--> statement-breakpoint
CREATE TYPE "public"."delivery_status" AS ENUM('PENDING', 'SENDING', 'SENT', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."pdf_status" AS ENUM('PENDING', 'READY');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('CENTRE', 'DISTRICT_OFFICER', 'QUALITY', 'STATE');--> statement-breakpoint
CREATE TYPE "public"."review_stage" AS ENUM('DISTRICT', 'QUALITY', 'STATE');--> statement-breakpoint
CREATE SEQUENCE "public"."certificate_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" uuid,
	"actor_name" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"batch_id" uuid,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"trace_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference" text NOT NULL,
	"title" text NOT NULL,
	"course" text NOT NULL,
	"centre_id" uuid NOT NULL,
	"district_id" uuid NOT NULL,
	"status" "batch_status" DEFAULT 'DRAFT' NOT NULL,
	"round" integer DEFAULT 0 NOT NULL,
	"candidate_count" integer DEFAULT 0 NOT NULL,
	"stage_entered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_reason" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "batches_reference_unique" UNIQUE("reference")
);
--> statement-breakpoint
CREATE TABLE "candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"enrolment_id" text NOT NULL,
	"full_name" text NOT NULL,
	"phone" text NOT NULL,
	"score" numeric(5, 2) NOT NULL,
	"row_number" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "centres" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"district_id" uuid NOT NULL,
	CONSTRAINT "centres_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "certificates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cert_number" text NOT NULL,
	"verification_code" text NOT NULL,
	"candidate_id" uuid NOT NULL,
	"enrolment_key" text NOT NULL,
	"batch_id" uuid NOT NULL,
	"holder_name" text NOT NULL,
	"course" text NOT NULL,
	"centre_name" text NOT NULL,
	"status" "certificate_status" DEFAULT 'VALID' NOT NULL,
	"pdf_status" "pdf_status" DEFAULT 'PENDING' NOT NULL,
	"pdf_path" text,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"revoke_reason" text,
	CONSTRAINT "certificates_cert_number_unique" UNIQUE("cert_number"),
	CONSTRAINT "certificates_verification_code_unique" UNIQUE("verification_code"),
	CONSTRAINT "certificates_candidate_id_unique" UNIQUE("candidate_id"),
	CONSTRAINT "certificates_enrolment_key_unique" UNIQUE("enrolment_key")
);
--> statement-breakpoint
CREATE TABLE "deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"certificate_id" uuid NOT NULL,
	"phone" text NOT NULL,
	"status" "delivery_status" DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"provider_message_id" text,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deliveries_certificate_id_unique" UNIQUE("certificate_id")
);
--> statement-breakpoint
CREATE TABLE "districts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "districts_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "escalations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"round" integer NOT NULL,
	"status" "batch_status" NOT NULL,
	"waiting_since" timestamp with time zone NOT NULL,
	"escalated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_by" uuid
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"trace_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "review_votes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"round" integer NOT NULL,
	"stage" "review_stage" NOT NULL,
	"actor_id" uuid NOT NULL,
	"decision" "decision" NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"withdrawn_at" timestamp with time zone,
	"withdraw_reason" text
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"display_name" text NOT NULL,
	"role" "role" NOT NULL,
	"centre_id" uuid,
	"district_id" uuid,
	"active" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_centre_id_centres_id_fk" FOREIGN KEY ("centre_id") REFERENCES "public"."centres"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_district_id_districts_id_fk" FOREIGN KEY ("district_id") REFERENCES "public"."districts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "centres" ADD CONSTRAINT "centres_district_id_districts_id_fk" FOREIGN KEY ("district_id") REFERENCES "public"."districts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_certificate_id_certificates_id_fk" FOREIGN KEY ("certificate_id") REFERENCES "public"."certificates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_acknowledged_by_users_id_fk" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_votes" ADD CONSTRAINT "review_votes_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_votes" ADD CONSTRAINT "review_votes_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_centre_id_centres_id_fk" FOREIGN KEY ("centre_id") REFERENCES "public"."centres"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_district_id_districts_id_fk" FOREIGN KEY ("district_id") REFERENCES "public"."districts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_batch_idx" ON "audit_log" USING btree ("batch_id","id");--> statement-breakpoint
CREATE INDEX "audit_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "batches_status_idx" ON "batches" USING btree ("status","stage_entered_at");--> statement-breakpoint
CREATE INDEX "batches_district_idx" ON "batches" USING btree ("district_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "candidates_batch_enrolment_uq" ON "candidates" USING btree ("batch_id","enrolment_id");--> statement-breakpoint
CREATE INDEX "certificates_batch_idx" ON "certificates" USING btree ("batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "escalations_once_uq" ON "escalations" USING btree ("batch_id","round","status");--> statement-breakpoint
CREATE INDEX "outbox_unpublished_idx" ON "outbox" USING btree ("id") WHERE published_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "review_votes_active_uq" ON "review_votes" USING btree ("batch_id","round","stage","actor_id") WHERE withdrawn_at IS NULL;