import type { Generation as GenerationRow } from "../../generated/prisma/client.js";
import type { StepName } from "../project/project.model.js";
import type { Generation, GenerationDto } from "./generation.model.js";

export const GenerationMapper = {
  toDomain(row: GenerationRow): Generation {
    return {
      projectId: row.projectId,
      step: row.step as StepName,
      sceneIndex: row.sceneIndex,
      promptKey: row.promptKey,
      promptVersion: row.promptVersion,
      prompt: row.prompt,
      provider: row.provider,
      model: row.model,
      createdAt: row.createdAt,
    };
  },
  toPersistence(g: Omit<Generation, "createdAt">) {
    return { ...g };
  },
  toDto(g: Generation): GenerationDto {
    return { ...g, createdAt: g.createdAt.toISOString() };
  },
};
