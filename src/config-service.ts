import type { Repos } from './db/repositories.js';
import { SETTING_CHANNEL, SETTING_ROLE } from './db/repositories.js';
import type { IdentifierEntry } from './tracking/identifiers.js';

export interface MonitoredCountry { iso3: string; name: string; }

/**
 * In-memory mirror of the persisted configuration. Every mutation writes to the database FIRST and then updates the
 * mirror before returning, so a command's reply is only sent once the change is already in effect for the poller
 * (e.g. removing an identifier stops alerts for aircraft that only matched it immediately).
 */
export class RuntimeConfig {
  private _identifiers: IdentifierEntry[] = [];
  private _countries = new Map<string, MonitoredCountry>();
  private _channelId: string | null = null;
  private _roleId: string | null = null;

  constructor(private readonly repos: Repos) {}

  async load(): Promise<void> {
    const [ids, countries, channel, role] = await Promise.all([
      this.repos.identifiers.list(),
      this.repos.countries.list(),
      this.repos.settings.get(SETTING_CHANNEL),
      this.repos.settings.get(SETTING_ROLE),
    ]);
    this._identifiers = ids;
    this._countries = new Map(countries.map((c) => [c.iso3, c]));
    this._channelId = channel;
    this._roleId = role;
  }

  get identifiers(): readonly IdentifierEntry[] { return this._identifiers; }
  get countries(): MonitoredCountry[] { return [...this._countries.values()].sort((a, b) => a.name.localeCompare(b.name)); }
  get channelId() { return this._channelId; }
  get roleId() { return this._roleId; }
  isMonitored(iso3: string): boolean { return this._countries.has(iso3); }
  /** Alerts need both a channel and a role to be configured; nothing is ever sent "somewhere else". */
  get isNotificationConfigured(): boolean { return !!this._channelId && !!this._roleId; }

  async addIdentifier(value: string, normalized: string, by: string | null): Promise<boolean> {
    const added = await this.repos.identifiers.add(value, normalized, by);
    await this.reloadIdentifiers();
    return added;
  }
  async removeIdentifier(normalized: string): Promise<boolean> {
    const removed = await this.repos.identifiers.remove(normalized);
    await this.reloadIdentifiers();
    return removed;
  }
  private async reloadIdentifiers() { this._identifiers = await this.repos.identifiers.list(); }

  async addCountry(iso3: string, name: string, by: string | null): Promise<boolean> {
    const added = await this.repos.countries.add(iso3, name, by);
    this._countries = new Map((await this.repos.countries.list()).map((c) => [c.iso3, c]));
    return added;
  }
  async removeCountry(iso3: string): Promise<boolean> {
    const removed = await this.repos.countries.remove(iso3);
    this._countries = new Map((await this.repos.countries.list()).map((c) => [c.iso3, c]));
    return removed;
  }
  async setChannel(id: string) { await this.repos.settings.set(SETTING_CHANNEL, id); this._channelId = id; }
  async setRole(id: string) { await this.repos.settings.set(SETTING_ROLE, id); this._roleId = id; }
}
