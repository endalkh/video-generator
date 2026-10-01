import type { ModelSetting as ModelSettingRow } from "../../generated/prisma/client.js";
import { defaultModelFor, ModelSetting, type ModelCapability } from "./model-setting.entity.js";

export interface ModelSettingDto {
  task: string;
  title: string;
  description: string;
  capability: ModelCapability;
  model: string;
  defaultModel: string;
  isDefault: boolean;
  updatedAt: string;
}

export const ModelSettingMapper = {
  toDomain(row: ModelSettingRow): ModelSetting {
    return ModelSetting.restore({ task: row.task, model: row.model, updatedAt: row.updatedAt });
  },
  toPersistence(s: ModelSetting) {
    return { task: s.task, model: s.model };
  },
  toDto(s: ModelSetting): ModelSettingDto {
    const d = s.definition;
    return {
      task: s.task,
      title: d.title,
      description: d.description,
      capability: d.capability,
      model: s.model,
      defaultModel: defaultModelFor(s.task),
      isDefault: s.isDefault,
      updatedAt: s.updatedAt.toISOString(),
    };
  },
};
