-- Channels: videos, monthly plans and prompt edits belong to a channel (channel_kits.id).

-- Videos
ALTER TABLE "projects" ADD COLUMN "channel_id" TEXT;
CREATE INDEX "projects_channel_id_updated_at_idx" ON "projects"("channel_id", "updated_at" DESC);

-- Prompts: "" = shared, otherwise a channel's own copy
ALTER TABLE "prompt_versions" DROP CONSTRAINT "prompt_versions_key_fkey";
DROP INDEX "prompt_versions_key_version_key";
ALTER TABLE "prompts" ADD COLUMN "channel_id" TEXT NOT NULL DEFAULT '';
ALTER TABLE "prompts" DROP CONSTRAINT "prompts_pkey";
ALTER TABLE "prompts" ADD CONSTRAINT "prompts_pkey" PRIMARY KEY ("channel_id", "key");
ALTER TABLE "prompt_versions" ADD COLUMN "channel_id" TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX "prompt_versions_channel_id_key_version_key" ON "prompt_versions"("channel_id", "key", "version");
ALTER TABLE "prompt_versions" ADD CONSTRAINT "prompt_versions_channel_id_key_fkey" FOREIGN KEY ("channel_id", "key") REFERENCES "prompts"("channel_id", "key") ON DELETE CASCADE ON UPDATE CASCADE;

-- Monthly plans: one per channel and month
ALTER TABLE "content_plans" ADD COLUMN "channel_id" TEXT NOT NULL DEFAULT '';
ALTER TABLE "content_plans" DROP CONSTRAINT "content_plans_pkey";
ALTER TABLE "content_plans" ADD CONSTRAINT "content_plans_pkey" PRIMARY KEY ("channel_id", "month");
