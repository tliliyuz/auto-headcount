ALTER TABLE "intent_responses" ALTER COLUMN "contact_ciphertext" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "intent_responses" ALTER COLUMN "contact_nonce" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "intent_responses" ALTER COLUMN "contact_key_version" DROP NOT NULL;