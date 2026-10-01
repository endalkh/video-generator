-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('new', 'running', 'paused', 'done', 'failed');

-- CreateTable
CREATE TABLE "projects" (
    "id" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "provider" TEXT NOT NULL,
    "status" "ProjectStatus" NOT NULL DEFAULT 'new',
    "error" TEXT,
    "completed" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "poem" JSONB,
    "scenes" JSONB,
    "character" JSONB,
    "song" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prompts" (
    "key" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "prompts_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "prompt_versions" (
    "id" BIGSERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "template" TEXT NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prompt_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generations" (
    "id" BIGSERIAL NOT NULL,
    "project_id" TEXT NOT NULL,
    "step" TEXT NOT NULL,
    "scene_index" INTEGER,
    "prompt_key" TEXT NOT NULL,
    "prompt_version" INTEGER NOT NULL,
    "prompt" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "generations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "projects_updated_at_idx" ON "projects"("updated_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "prompt_versions_key_version_key" ON "prompt_versions"("key", "version");

-- CreateIndex
CREATE INDEX "generations_project_id_id_idx" ON "generations"("project_id", "id");

-- AddForeignKey
ALTER TABLE "prompt_versions" ADD CONSTRAINT "prompt_versions_key_fkey" FOREIGN KEY ("key") REFERENCES "prompts"("key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generations" ADD CONSTRAINT "generations_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
