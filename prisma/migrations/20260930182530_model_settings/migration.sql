-- AlterTable
ALTER TABLE "generations" ADD COLUMN     "model" TEXT NOT NULL DEFAULT '';

-- CreateTable
CREATE TABLE "model_settings" (
    "task" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "model_settings_pkey" PRIMARY KEY ("task")
);
