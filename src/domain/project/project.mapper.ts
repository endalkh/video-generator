import { Prisma, type Project as ProjectRow } from "../../generated/prisma/client.js";
import { Project, type ProjectProps } from "./project.entity.js";
import {
  CharacterSchema,
  PoemSchema,
  PublishInfoSchema,
  ProjectInputSchema,
  ScenePlanSchema,
  SongTimelineSchema,
  StepNameSchema,
  type ProjectInput,
  type ProjectStatus,
  type StepName,
} from "./project.model.js";

/** Public shape returned by the API. */
export interface ProjectDto {
  id: string;
  channelId: string | null;
  topic: string;
  input: ProjectInput;
  provider: string;
  status: ProjectStatus;
  error: string | null;
  completed: StepName[];
  approved: StepName[];
  /** Manual mode: step waiting for review. */
  awaitingReview: StepName | null;
  nextStep: StepName | null;
  poem: ProjectProps["poem"];
  scenes: ProjectProps["scenes"];
  character: ProjectProps["character"];
  song: { file: string; duration: number; source: "ai" | "music_voice" | "upload" } | null;
  publish: ProjectProps["publish"];
  createdAt: string;
  updatedAt: string;
}

export interface ProjectSummaryDto {
  id: string;
  channelId: string | null;
  topic: string;
  /** Song/poem title once written, else null. */
  title: string | null;
  language: ProjectInput["language"];
  status: ProjectStatus;
  completed: StepName[];
  updatedAt: string;
}

/** JSON columns are validated on the way in, so a hand-edited row can't corrupt the domain. */
const nullable = <T>(schema: { parse(v: unknown): T }, v: unknown): T | null => (v === null || v === undefined ? null : schema.parse(v));
const json = (v: unknown) => (v === null || v === undefined ? Prisma.DbNull : (v as Prisma.InputJsonValue));

export const ProjectMapper = {
  toDomain(row: ProjectRow): Project {
    return Project.restore({
      id: row.id,
      channelId: row.channelId ?? null,
      input: ProjectInputSchema.parse(row.input),
      provider: row.provider,
      status: row.status,
      error: row.error,
      completed: row.completed.map((s) => StepNameSchema.parse(s)),
      approved: (row.approved ?? []).map((s) => StepNameSchema.parse(s)),
      poem: nullable(PoemSchema, row.poem),
      scenes: nullable(ScenePlanSchema, row.scenes),
      character: nullable(CharacterSchema, row.character),
      song: nullable(SongTimelineSchema, row.song),
      publish: nullable(PublishInfoSchema, row.publish),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  },

  /** Prisma create/update payload. */
  toPersistence(project: Project) {
    const p = project.toProps();
    const j = json;
    return {
      id: p.id,
      channelId: p.channelId,
      topic: p.input.topic,
      input: p.input as Prisma.InputJsonValue,
      provider: p.provider,
      status: p.status,
      error: p.error,
      completed: p.completed,
      approved: p.approved,
      poem: j(p.poem),
      scenes: j(p.scenes),
      character: j(p.character),
      song: j(p.song),
      publish: j(p.publish),
      createdAt: p.createdAt,
    };
  },

  toDto(project: Project): ProjectDto {
    const p = project.toProps();
    return {
      id: p.id,
      channelId: p.channelId,
      topic: p.input.topic,
      input: p.input,
      provider: p.provider,
      status: p.status,
      error: p.error,
      completed: p.completed,
      approved: p.approved,
      awaitingReview: project.awaitingReview,
      nextStep: project.nextStep ?? null,
      poem: p.poem,
      scenes: p.scenes,
      character: p.character,
      song: p.song ? { file: p.song.file, duration: p.song.duration, source: p.song.source ?? "ai" } : null,
      publish: p.publish,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
    };
  },

  toSummaryDto(project: Project): ProjectSummaryDto {
    return {
      id: project.id,
      channelId: project.channelId,
      topic: project.topic,
      title: project.poem?.title ?? null,
      language: project.input.language,
      status: project.status,
      completed: [...project.completed],
      updatedAt: project.updatedAt.toISOString(),
    };
  },
};
