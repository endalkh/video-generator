-- Secondary recurring characters (besides the main `character`), each with its own reference image on disk.
ALTER TABLE "projects" ADD COLUMN "cast" JSONB;
