-- AlterEnum
ALTER TYPE "ProjectStatus" ADD VALUE 'review';

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "approved" TEXT[] DEFAULT ARRAY[]::TEXT[];
