CREATE TABLE "aircraft_cooldowns" (
	"aircraft_id" text PRIMARY KEY NOT NULL,
	"callsign" text NOT NULL,
	"last_alert_at" timestamp with time zone NOT NULL,
	"last_country_iso3" text,
	"alert_count" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "aircraft_tracking" (
	"aircraft_id" text PRIMARY KEY NOT NULL,
	"callsign" text NOT NULL,
	"account_id" bigint,
	"aircraft_type_id" integer,
	"matched_identifiers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"lat" double precision,
	"lon" double precision,
	"altitude_m" double precision,
	"speed_kts" double precision,
	"heading_deg" double precision,
	"country_iso3" text,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"last_alert_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "identifiers" (
	"id" serial PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"normalized" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identifiers_normalized_unique" UNIQUE("normalized")
);
--> statement-breakpoint
CREATE TABLE "ignored_aircraft" (
	"aircraft_id" text PRIMARY KEY NOT NULL,
	"callsign" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "monitored_countries" (
	"iso3" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "aircraft_cooldowns_last_alert_idx" ON "aircraft_cooldowns" USING btree ("last_alert_at");--> statement-breakpoint
CREATE INDEX "aircraft_tracking_last_seen_idx" ON "aircraft_tracking" USING btree ("last_seen_at");--> statement-breakpoint
CREATE INDEX "ignored_aircraft_expires_idx" ON "ignored_aircraft" USING btree ("expires_at");