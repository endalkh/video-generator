import { capabilityOf, MODEL_TASKS, ModelSetting, modelTaskDefinition, type ModelCapability, type ModelSelection } from "../domain/model-setting/model-setting.entity.js";
import { ModelSettingMapper, type ModelSettingDto } from "../domain/model-setting/model-setting.mapper.js";
import type { AvailableModel } from "../domain/ports/generator.port.js";
import type { ModelSettingRepository } from "../repositories/repositories.js";
import { log } from "../util/log.js";
import type { ProviderFactory } from "./project.service.js";

export interface ModelOptionsDto {
  /** Models grouped by capability, for the per-task dropdowns. */
  byCapability: Record<ModelCapability, AvailableModel[]>;
  /** Set when the live list couldn't be fetched (e.g. no API key); dropdowns still show current values. */
  warning: string | null;
}

/** Use cases for choosing which model runs each pipeline task. */
export class ModelSettingsService {
  constructor(
    private readonly settings: ModelSettingRepository,
    private readonly providers: ProviderFactory,
  ) {}

  /** Insert defaults for tasks that have no setting yet. */
  async seedDefaults(): Promise<number> {
    let added = 0;
    for (const t of MODEL_TASKS) if (await this.settings.createIfMissing(ModelSetting.default(t.task))) added++;
    return added;
  }

  async list(): Promise<ModelSettingDto[]> {
    const byTask = new Map((await this.settings.list()).map((s) => [s.task, s]));
    return MODEL_TASKS.map((t) => ModelSettingMapper.toDto(byTask.get(t.task) ?? ModelSetting.default(t.task)));
  }

  async update(task: string, model: string): Promise<ModelSettingDto> {
    const setting = await this.load(task);
    setting.change(model);
    await this.settings.save(setting);
    return ModelSettingMapper.toDto(setting);
  }

  async reset(task: string): Promise<ModelSettingDto> {
    const def = ModelSetting.default(task);
    return this.update(task, def.model);
  }

  /** Models the provider offers, grouped by what they can do. */
  async availableModels(providerName = "gemini"): Promise<ModelOptionsDto> {
    const byCapability: Record<ModelCapability, AvailableModel[]> = { text: [], image: [], tts: [], music: [], video: [] };
    let warning: string | null = null;
    try {
      for (const m of await this.providers(providerName).listModels()) {
        const cap = capabilityOf(m.id);
        if (cap) byCapability[cap].push(m);
      }
      for (const list of Object.values(byCapability)) list.sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }));
    } catch (err) {
      warning = `Couldn't load the model list from ${providerName}: ${(err as Error).message}`;
      log.warn(warning);
    }
    return { byCapability, warning };
  }

  /** Snapshot of all task → model choices for one run. */
  async snapshot(): Promise<ModelSelection> {
    const list = await this.list();
    return Object.fromEntries(list.map((s) => [s.task, s.model])) as ModelSelection;
  }

  private async load(task: string): Promise<ModelSetting> {
    modelTaskDefinition(task);
    return (await this.settings.findByTask(task)) ?? ModelSetting.default(task);
  }
}
