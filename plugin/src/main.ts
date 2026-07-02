import { App, Notice, Plugin, PluginSettingTab, Setting, TAbstractFile, debounce } from "obsidian";
import { JmapClient } from "./jmap.ts";
import { SyncEngine, SyncState, SyncReport, JyncConfig, ConflictStrategy } from "./sync.ts";
import { JmapAuth } from "./paths.ts";

interface JyncSettings extends JyncConfig {
  baseUrl: string;
  authMode: "basic" | "bearer";
  username: string;
  password: string;
  token: string;
  autoSyncSeconds: number;
  syncOnChange: boolean;
}

const DEFAULTS: JyncSettings = {
  baseUrl: "http://localhost:8091",
  authMode: "basic",
  username: "", // no "admin" nudge — use a dedicated, least-privilege account (F4)
  password: "",
  token: "", // bearer token (OAuth access token or app token) when authMode = bearer
  syncRoot: "Jync",
  remoteRootName: "Jync",
  allowLocalDeletes: false,
  ignore: [".DS_Store", "*.tmp"],
  conflictStrategy: "copy",
  autoSyncSeconds: 0,
  syncOnChange: true,
};

interface PersistedData {
  settings: JyncSettings;
  syncState: SyncState;
}

const EMPTY_STATE: SyncState = { folders: {}, files: {} };

/** True when the URL sends Basic credentials in clear (plain http to a non-local host). F3. */
function isInsecureUrl(baseUrl: string): boolean {
  try {
    const u = new URL(baseUrl);
    return u.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch {
    return true;
  }
}

export default class JyncPlugin extends Plugin {
  settings!: JyncSettings;
  syncState!: SyncState;
  private statusEl!: HTMLElement;
  private intervalId: number | null = null;
  private syncing = false;
  lastReport: SyncReport | null = null; // exposed for e2e/debugging + settings readout
  lastSyncAt = 0;

  async onload() {
    const data = ((await this.loadData()) ?? {}) as Partial<PersistedData>;
    this.settings = Object.assign({}, DEFAULTS, data.settings);
    this.syncState = Object.assign({}, EMPTY_STATE, data.syncState);

    this.statusEl = this.addStatusBarItem();
    this.setStatus("idle");

    this.addRibbonIcon("refresh-cw", "Jync: sync now", () => this.runSync("manual"));
    this.addCommand({ id: "jync-sync-now", name: "Sync now", callback: () => this.runSync("manual") });
    this.addSettingTab(new JyncSettingTab(this.app, this));

    // debounced sync on local changes under the sync root
    const debounced = debounce(() => this.runSync("change"), 2500, true);
    const underRoot = (f: TAbstractFile) => f.path === this.settings.syncRoot || f.path.startsWith(this.settings.syncRoot + "/");
    const hook = (f: TAbstractFile) => {
      if (this.settings.syncOnChange && underRoot(f)) debounced();
    };
    this.registerEvent(this.app.vault.on("modify", hook));
    this.registerEvent(this.app.vault.on("create", hook));
    this.registerEvent(this.app.vault.on("delete", hook));
    this.registerEvent(this.app.vault.on("rename", (f, old) => {
      if (this.settings.syncOnChange && (underRoot(f) || old.startsWith(this.settings.syncRoot + "/"))) debounced();
    }));

    this.applyInterval();
    console.log("[jync] loaded", { root: this.settings.syncRoot, base: this.settings.baseUrl });
  }

  onunload() {
    if (this.intervalId) window.clearInterval(this.intervalId);
  }

  applyInterval() {
    if (this.intervalId) { window.clearInterval(this.intervalId); this.intervalId = null; }
    if (this.settings.autoSyncSeconds > 0) {
      this.intervalId = window.setInterval(() => this.runSync("interval"), this.settings.autoSyncSeconds * 1000);
      this.registerInterval(this.intervalId);
    }
  }

  setStatus(text: string) {
    this.statusEl.setText("Jync: " + text);
  }

  async persist() {
    const data: PersistedData = { settings: this.settings, syncState: this.syncState };
    await this.saveData(data);
  }

  /** Build JMAP auth from settings, or null if credentials are missing. */
  authOrNull(): JmapAuth | null {
    const s = this.settings;
    if (s.authMode === "bearer") return s.token ? { type: "bearer", token: s.token } : null;
    return s.password ? { type: "basic", user: s.username, pass: s.password } : null;
  }

  async runSync(trigger: string) {
    if (this.syncing) return;
    const auth = this.authOrNull();
    if (!auth) { new Notice("Jync: set credentials in settings"); return; }
    this.syncing = true;
    this.setStatus("syncing…");
    if (isInsecureUrl(this.settings.baseUrl)) console.warn("[jync] insecure transport: credentials sent over plain HTTP to a non-local host");
    try {
      const client = new JmapClient({ baseUrl: this.settings.baseUrl, auth });
      const engine = new SyncEngine(
        this.app.vault.adapter,
        client,
        {
          syncRoot: this.settings.syncRoot,
          remoteRootName: this.settings.remoteRootName,
          allowLocalDeletes: this.settings.allowLocalDeletes,
          ignore: this.settings.ignore,
          conflictStrategy: this.settings.conflictStrategy,
        },
        this.syncState,
        async (s) => { this.syncState = s; await this.persist(); },
      );
      const r = await engine.sync();
      this.lastReport = r;
      this.lastSyncAt = Date.now();
      const summary = `↓${r.pulled} +${r.pushedNew} ~${r.pushedEdit} →${r.movedRemote} -${r.deletedRemote} !${r.conflicts}`;
      this.setStatus(summary);
      if (trigger === "manual") new Notice(`Jync synced: ${summary}` + (r.errors.length ? ` (${r.errors.length} errors)` : ""));
      if (r.errors.length) console.error("[jync] errors", r.errors);
      return r;
    } catch (e: any) {
      console.error("[jync] sync failed", e);
      this.setStatus("error");
      if (trigger === "manual") new Notice("Jync error: " + e.message);
    } finally {
      this.syncing = false;
    }
  }

  /** Verify server URL + credentials and that JMAP FileNode is available. */
  async testConnection(): Promise<string> {
    const auth = this.authOrNull();
    if (!auth) return "Set credentials first";
    try {
      const client = new JmapClient({ baseUrl: this.settings.baseUrl, auth });
      const session = await client.connect();
      if (!client.hasFileNode()) return `Connected as ${session.username}, but the server does not advertise JMAP FileNode`;
      return `OK — connected as ${session.username}; FileNode available`;
    } catch (e: any) {
      return `Failed: ${e.message}`;
    }
  }
}

class JyncSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: JyncPlugin) { super(app, plugin); }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Jync — JMAP FileNode sync" });

    const s = this.plugin.settings;
    const save = async () => this.plugin.persist();

    // Last-sync readout
    const lr = this.plugin.lastReport;
    if (lr) {
      const when = this.plugin.lastSyncAt ? new Date(this.plugin.lastSyncAt).toLocaleString() : "—";
      new Setting(containerEl)
        .setName("Last sync")
        .setDesc(`${when} · ↓${lr.pulled} +${lr.pushedNew} ~${lr.pushedEdit} →${lr.movedRemote} -${lr.deletedRemote} !${lr.conflicts}${lr.errors.length ? ` · ${lr.errors.length} error(s)` : ""}`);
    }

    new Setting(containerEl).setName("Server").setHeading();
    if (isInsecureUrl(s.baseUrl)) {
      const warn = new Setting(containerEl)
        .setName("⚠ Insecure transport")
        .setDesc("Credentials and content are sent over plain HTTP to a non-local host. Use HTTPS.");
      warn.settingEl.addClass("mod-warning");
      warn.nameEl.style.color = "var(--text-error)";
    }
    new Setting(containerEl).setName("Server URL").setDesc("JMAP origin (e.g. your Stalwart server)")
      .addText((t) => t.setValue(s.baseUrl).onChange(async (v) => { s.baseUrl = v.trim(); await save(); }));
    new Setting(containerEl).setName("Authentication").setDesc("Bearer token (OAuth / app token) is preferred over a password")
      .addDropdown((d) => d
        .addOption("basic", "Username + password")
        .addOption("bearer", "Bearer token")
        .setValue(s.authMode)
        .onChange(async (v) => { s.authMode = v as "basic" | "bearer"; await save(); this.display(); }));
    if (s.authMode === "bearer") {
      new Setting(containerEl).setName("Bearer token").setDesc("An OAuth access token or app token; sent as Authorization: Bearer")
        .addText((t) => { t.inputEl.type = "password"; t.setValue(s.token).onChange(async (v) => { s.token = v.trim(); await save(); }); });
    } else {
      new Setting(containerEl).setName("Username")
        .addText((t) => t.setValue(s.username).onChange(async (v) => { s.username = v.trim(); await save(); }));
      new Setting(containerEl).setName("Password").setDesc("Stored in the plugin's data.json — prefer a dedicated, scoped account")
        .addText((t) => { t.inputEl.type = "password"; t.setValue(s.password).onChange(async (v) => { s.password = v; await save(); }); });
    }
    new Setting(containerEl).setName("Connection").setDesc("Verify the URL, credentials, and FileNode support")
      .addButton((b) => b.setButtonText("Test connection").onClick(async () => {
        b.setButtonText("Testing…").setDisabled(true);
        const r = await this.plugin.testConnection();
        new Notice("Jync: " + r);
        b.setButtonText("Test connection").setDisabled(false);
      }));

    new Setting(containerEl).setName("Sync").setHeading();
    new Setting(containerEl).setName("Sync root (vault folder)").setDesc("Only this subtree is synced")
      .addText((t) => t.setValue(s.syncRoot).onChange(async (v) => { s.syncRoot = v.trim().replace(/^\/+|\/+$/g, ""); await save(); }));
    new Setting(containerEl).setName("Remote root folder name")
      .addText((t) => t.setValue(s.remoteRootName).onChange(async (v) => { s.remoteRootName = v.trim(); await save(); }));
    new Setting(containerEl).setName("Ignore patterns").setDesc("One glob per line, relative to sync root (e.g. *.tmp, Excalidraw/, **/drafts)")
      .addTextArea((t) => { t.inputEl.rows = 4; t.setValue(s.ignore.join("\n")).onChange(async (v) => { s.ignore = v.split("\n").map((x) => x.trim()).filter(Boolean); await save(); }); });
    new Setting(containerEl).setName("Conflict resolution").setDesc("When a note changed on both sides since the last sync")
      .addDropdown((d) => d
        .addOption("copy", "Keep both (write a conflict copy)")
        .addOption("prefer-local", "Local wins")
        .addOption("prefer-remote", "Remote wins")
        .setValue(s.conflictStrategy)
        .onChange(async (v) => { s.conflictStrategy = v as ConflictStrategy; await save(); }));

    new Setting(containerEl).setName("Advanced").setHeading();
    new Setting(containerEl).setName("Sync on change").setDesc("Debounced sync when files under the root change")
      .addToggle((t) => t.setValue(s.syncOnChange).onChange(async (v) => { s.syncOnChange = v; await save(); }));
    new Setting(containerEl).setName("Auto-sync interval (seconds)").setDesc("0 = off")
      .addText((t) => t.setValue(String(s.autoSyncSeconds)).onChange(async (v) => { s.autoSyncSeconds = Math.max(0, parseInt(v) || 0); await save(); this.plugin.applyInterval(); }));
    new Setting(containerEl).setName("Allow local deletes").setDesc("DANGER: let remote deletions remove local files")
      .addToggle((t) => t.setValue(s.allowLocalDeletes).onChange(async (v) => { s.allowLocalDeletes = v; await save(); }));

    new Setting(containerEl).addButton((b) => b.setButtonText("Sync now").setCta().onClick(() => this.plugin.runSync("manual")));
    new Setting(containerEl).addButton((b) => b.setButtonText("Reset sync state").setWarning().onClick(async () => {
      this.plugin.syncState = { folders: {}, files: {} };
      await this.plugin.persist();
      new Notice("Jync: sync state reset (next sync re-scans)");
    }));
  }
}
