import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // Read from .env locally, or from the container environment in Docker.
    // Optional here so `prisma generate` (which never connects) works during the image build,
    // where .env is deliberately not copied; `migrate`/`db` commands still need it at runtime.
    url: process.env.DATABASE_URL,
  },
});
