import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";

export type Db = PrismaClient;

/** DATABASE_URL comes from .env (loaded by dotenv in the entry points). */
export function createPrismaClient(url = process.env.DATABASE_URL): Db {
  if (!url) throw new Error("DATABASE_URL is not set. Add it to .env, e.g. DATABASE_URL=\"postgresql://USER@localhost:5432/kids_studio?schema=public\"");
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
}

export function redactUrl(url: string): string {
  return url.replace(/\/\/([^:/@]+):[^@]*@/, "//$1:***@");
}
