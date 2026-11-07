import { PermissionFlagsBits, type ChatInputCommandInteraction, type GuildMember } from 'discord.js';
import type { Config } from '../config.js';

/**
 * Administrative commands require ONE of:
 *  - the Discord "Administrator" permission in the server,
 *  - the user's id listed in AUTHORIZED_USER_IDS,
 *  - a role listed in ADMIN_ROLE_IDS.
 */
export function isAuthorized(i: ChatInputCommandInteraction, cfg: Config): boolean {
  if (cfg.AUTHORIZED_USER_IDS.includes(i.user.id)) return true;
  if (i.memberPermissions?.has(PermissionFlagsBits.Administrator)) return true;
  const member = i.member as GuildMember | null;
  const roles = member && 'cache' in (member.roles ?? {}) ? [...(member.roles as GuildMember['roles']).cache.keys()] : Array.isArray(member?.roles) ? (member!.roles as unknown as string[]) : [];
  return roles.some((r) => cfg.ADMIN_ROLE_IDS.includes(r));
}
