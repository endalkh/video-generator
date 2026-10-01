import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildServices, type Container } from "../src/container.js";
import { MockProvider } from "../src/infrastructure/providers/mock.js";
import { InMemoryGenerationRepository, InMemoryModelSettingRepository, InMemoryProjectRepository, InMemoryPromptRepository } from "../src/repositories/memory/memory.repositories.js";

export const mockProvider = () => new MockProvider({ audioSecondsPerScene: 1, songLengthSec: 4, imageSize: [320, 180] });

/** Services wired to in-memory repositories and a temp media folder. */
export async function makeTestContainer(): Promise<Container & { mediaRoot: string; generations: InMemoryGenerationRepository; cleanup(): Promise<void> }> {
  const mediaRoot = await mkdtemp(path.join(os.tmpdir(), "kids-studio-test-"));
  const generations = new InMemoryGenerationRepository();
  const c = buildServices({
    projects: new InMemoryProjectRepository(),
    prompts: new InMemoryPromptRepository(),
    generations,
    modelSettings: new InMemoryModelSettingRepository(),
    mediaRoot,
    providers: (name) => {
      if (name !== "mock") throw new Error(`tests only use the mock provider, got ${name}`);
      return mockProvider();
    },
  });
  await c.promptService.seedDefaults();
  await c.modelSettingsService.seedDefaults();
  return { ...c, mediaRoot, generations, cleanup: async () => { await c.close(); await rm(mediaRoot, { recursive: true, force: true }); } };
}
