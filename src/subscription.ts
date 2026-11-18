export type ChannelMember = { status: string; is_member?: boolean };

export function isAllowedChannelMember(member: ChannelMember): boolean {
  return ["creator", "administrator", "member"].includes(member.status)
    || (member.status === "restricted" && member.is_member === true);
}

export function isFactoryAdmin(userId: number, configuredIds: string | undefined): boolean {
  if (!configuredIds) return false;
  return configuredIds.split(",").some((value) => value.trim() === String(userId));
}
