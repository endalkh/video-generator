-- YouTube upload info (title, description, tags, thumbnail text) made at the end of each video.
ALTER TABLE "projects" ADD COLUMN "publish" JSONB;
