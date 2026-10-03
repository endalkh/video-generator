-- CreateTable
CREATE TABLE "content_plans" (
    "month" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "theme" TEXT,
    "ideas" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "content_plans_pkey" PRIMARY KEY ("month")
);
