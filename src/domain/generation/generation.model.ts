import type { StepName } from "../project/project.model.js";

/** Audit record of a rendered prompt sent to a model. */
export interface Generation {
  projectId: string;
  step: StepName;
  sceneIndex: number | null;
  promptKey: string;
  promptVersion: number;
  prompt: string;
  provider: string;
  model: string;
  createdAt: Date;
}

export interface GenerationDto extends Omit<Generation, "createdAt"> {
  createdAt: string;
}

