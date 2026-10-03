-- CreateTable
CREATE TABLE "channel_kits" (
    "id" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "provider" TEXT NOT NULL,
    "details" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channel_kits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "channel_kits_updated_at_idx" ON "channel_kits"("updated_at" DESC);
