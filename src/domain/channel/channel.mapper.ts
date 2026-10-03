import { Prisma, type ChannelKit as ChannelKitRow } from "../../generated/prisma/client.js";
import { ChannelKit } from "./channel.entity.js";
import { ChannelDetailsSchema, ChannelInputSchema, type ChannelDetails, type ChannelInput } from "./channel.model.js";

export interface ChannelKitDto {
  id: string;
  input: ChannelInput;
  provider: string;
  details: ChannelDetails | null;
  createdAt: string;
  updatedAt: string;
}

export const ChannelKitMapper = {
  /** JSON columns are validated on the way in, so a hand-edited row can't corrupt the domain. */
  toDomain(row: ChannelKitRow): ChannelKit {
    return ChannelKit.restore({
      id: row.id,
      input: ChannelInputSchema.parse(row.input),
      provider: row.provider,
      details: row.details == null ? null : ChannelDetailsSchema.parse(row.details),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  },

  toPersistence(kit: ChannelKit) {
    const p = kit.toProps();
    return {
      id: p.id,
      input: p.input as Prisma.InputJsonValue,
      provider: p.provider,
      details: p.details === null ? Prisma.DbNull : (p.details as Prisma.InputJsonValue),
      createdAt: p.createdAt,
    };
  },

  toDto(kit: ChannelKit): ChannelKitDto {
    const p = kit.toProps();
    return { id: p.id, input: p.input, provider: p.provider, details: p.details, createdAt: p.createdAt.toISOString(), updatedAt: p.updatedAt.toISOString() };
  },
};
