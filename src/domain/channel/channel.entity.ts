import { ValidationError } from "../errors.js";
import { ChannelDetailsSchema, ChannelInputSchema, normalizeChannelDetails, type ChannelDetails, type ChannelInput } from "./channel.model.js";

export interface ChannelKitProps {
  id: string;
  input: ChannelInput;
  provider: string;
  details: ChannelDetails | null;
  createdAt: Date;
  updatedAt: Date;
}

const issues = (e: { issues: { path: PropertyKey[]; message: string }[] }, what: string) => e.issues.map((i) => `${i.path.map(String).join(".") || what}: ${i.message}`);

export function parseChannelInput(raw: unknown): ChannelInput {
  const r = ChannelInputSchema.safeParse(raw ?? {});
  if (!r.success) throw new ValidationError("Invalid channel input", issues(r.error, "input"));
  return r.data;
}

export function parseChannelDetails(raw: unknown): ChannelDetails {
  const r = ChannelDetailsSchema.safeParse(raw);
  if (!r.success) throw new ValidationError("Invalid channel details", issues(r.error, "details"));
  return normalizeChannelDetails(r.data);
}

/**
 * A YouTube channel brand kit: the brief (prompt and/or sample photo), the channel text and the
 * pictures YouTube needs. Text lives in Postgres; pictures live on disk.
 */
export class ChannelKit {
  private constructor(private props: ChannelKitProps) {}

  static create(args: { id: string; input: ChannelInput; provider: string; hasPhoto: boolean }, now = new Date()): ChannelKit {
    ChannelKit.assertBrief(args.input, args.hasPhoto);
    return new ChannelKit({ id: args.id, input: args.input, provider: args.provider, details: null, createdAt: now, updatedAt: now });
  }

  static restore(props: ChannelKitProps): ChannelKit {
    return new ChannelKit({ ...props });
  }

  /** A kit needs something to work from: a prompt, a sample photo, or at least a name. */
  static assertBrief(input: ChannelInput, hasPhoto: boolean): void {
    if (!hasPhoto && !input.brief && !input.name) throw new ValidationError("Add a sample photo or describe the channel (a prompt)");
    if (!hasPhoto && input.brief && input.brief.length < 3) throw new ValidationError("Describe the channel in a few more words");
  }

  get id() { return this.props.id; }
  get input() { return this.props.input; }
  get provider() { return this.props.provider; }
  get details() { return this.props.details; }
  get createdAt() { return this.props.createdAt; }
  get updatedAt() { return this.props.updatedAt; }

  /** The name to put on the pictures: the generated/edited one, else the one the user typed. */
  get channelName(): string | undefined {
    return this.props.details?.name || this.props.input.name;
  }

  editInput(input: ChannelInput, hasPhoto: boolean, provider?: string): void {
    ChannelKit.assertBrief(input, hasPhoto);
    this.props.input = input;
    if (provider) this.props.provider = provider;
    this.touch();
  }

  setDetails(details: ChannelDetails): void {
    this.props.details = normalizeChannelDetails(details);
    this.touch();
  }

  private touch(): void {
    this.props.updatedAt = new Date();
  }

  toProps(): ChannelKitProps {
    return structuredClone(this.props);
  }
}
