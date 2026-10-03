import path from "node:path";
import { GeminiProvider } from "./infrastructure/providers/gemini.js";
import { MockProvider } from "./infrastructure/providers/mock.js";
import { createPrismaClient, type Db } from "./infrastructure/prisma.js";
import type { ChannelKitRepository, ContentPlanRepository, GenerationRepository, ModelSettingRepository, ProjectRepository, PromptRepository } from "./repositories/repositories.js";
import { PrismaChannelKitRepository, PrismaContentPlanRepository, PrismaGenerationRepository, PrismaModelSettingRepository, PrismaProjectRepository, PrismaPromptRepository } from "./repositories/prisma/prisma.repositories.js";
import { InMemoryChannelKitRepository, InMemoryContentPlanRepository } from "./repositories/memory/memory.repositories.js";
import { ValidationError } from "./domain/errors.js";
import type { Provider } from "./domain/ports/generator.port.js";
import { ChannelService } from "./services/channel.service.js";
import { PipelineService } from "./services/pipeline.service.js";
import { PlanService } from "./services/plan.service.js";
import { ProjectService, type ProviderFactory } from "./services/project.service.js";
import { PromptService } from "./services/prompt.service.js";
import { ModelSettingsService } from "./services/model-settings.service.js";

export const PROVIDER_NAMES = ["gemini", "mock"] as const;

export const defaultProviderFactory: ProviderFactory = (name): Provider => {
  if (name === "mock") return new MockProvider();
  if (name === "gemini") return new GeminiProvider();
  throw new ValidationError(`Unknown provider "${name}" (use ${PROVIDER_NAMES.join(" or ")})`);
};

export interface Container {
  promptService: PromptService;
  modelSettingsService: ModelSettingsService;
  projectService: ProjectService;
  pipelineService: PipelineService;
  channelService: ChannelService;
  planService: PlanService;
  close(): Promise<void>;
}

/** Wire repositories → services. Tests call this with in-memory repositories. */
export function buildServices(deps: {
  projects: ProjectRepository;
  prompts: PromptRepository;
  generations: GenerationRepository;
  modelSettings: ModelSettingRepository;
  /** YouTube channel kits (Channel page); in-memory when omitted. */
  channelKits?: ChannelKitRepository;
  /** Monthly ideas & schedule; in-memory when omitted. */
  contentPlans?: ContentPlanRepository;
  mediaRoot: string;
  providers?: ProviderFactory;
  close?: () => Promise<void>;
}): Container {
  const providers = deps.providers ?? defaultProviderFactory;
  const promptService = new PromptService(deps.prompts);
  const modelSettingsService = new ModelSettingsService(deps.modelSettings, providers);
  const pipelineService = new PipelineService(deps.projects, deps.generations, promptService, modelSettingsService, path.resolve(deps.mediaRoot));
  const projectService = new ProjectService(deps.projects, deps.generations, pipelineService, providers);
  const contentPlans = deps.contentPlans ?? new InMemoryContentPlanRepository();
  const channelService = new ChannelService(deps.channelKits ?? new InMemoryChannelKitRepository(), promptService, modelSettingsService, providers, path.resolve(deps.mediaRoot), projectService, contentPlans);
  projectService.assertChannel = channelService.assertExists;
  const planService = new PlanService(contentPlans, promptService, modelSettingsService, providers, projectService, channelService.assertExists);
  return {
    promptService,
    modelSettingsService,
    projectService,
    pipelineService,
    channelService,
    planService,
    close: async () => {
      await projectService.shutdown();
      await deps.close?.();
    },
  };
}

/** Production wiring: Prisma/Postgres (DATABASE_URL from .env) + media under ./output. */
export async function createContainer(opts: { mediaRoot?: string; db?: Db } = {}): Promise<Container> {
  const db = opts.db ?? createPrismaClient();
  try {
    await db.$connect();
  } catch (err) {
    throw new Error(`Can't connect to Postgres (DATABASE_URL in .env): ${(err as Error).message}\nIs Postgres running, and have you run \`npm run db:migrate\`?`);
  }
  const c = buildServices({
    projects: new PrismaProjectRepository(db),
    prompts: new PrismaPromptRepository(db),
    generations: new PrismaGenerationRepository(db),
    modelSettings: new PrismaModelSettingRepository(db),
    channelKits: new PrismaChannelKitRepository(db),
    contentPlans: new PrismaContentPlanRepository(db),
    mediaRoot: opts.mediaRoot ?? process.env.MEDIA_ROOT ?? "output",
    close: () => db.$disconnect(),
  });
  await c.promptService.seedDefaults();
  await c.modelSettingsService.seedDefaults();
  await c.projectService.recoverInterrupted();
  await c.channelService.adoptLegacy();
  return c;
}
