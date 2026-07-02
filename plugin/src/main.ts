import { App, Notice, Plugin, PluginSettingTab, Setting, TFile, TAbstractFile, debounce } from "obsidian";
import { JmapClient } from "./jmap.ts";
import { SyncEngine, SyncState, JyncConfig } from "./sync.ts";

interface JyncSettings extends JyncConfig {
  baseUrl: string;
  username: string;
  password: string;
  autoSyncSeconds: number;
  syncOnChange: boolean;
}

const DEFAULTS: JyncSettings = {
  baseUrl: "http://localhost:8091",
  username: "admin",
  password: "",
  syncRoot: "Jync",
  remoteRootName: "Jync",
  allowLocalDeletes: false,
  autoSyncSeconds: 0,
  syncOnChange: true,
};

interface PersistedData {
  settings: JyncSettings;
  syncState: SyncState;
}

const EMPTY_STATE: SyncState = { folders: {}, files: {} };

export default class JyncPlugin extends Plugin {
  settings!: JyncSettings;
  syncState!: SyncState;
  private statusEl!: HTMLElement;
  private intervalId: number | null = null;
  private syncing = false;
  lastReport: unknown = null; // exposed for e2e/debugging

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

  async runSync(trigger: string) {
    if (this.syncing) return;
    if (!this.settings.password) { new Notice("Jync: set a password in settings"); return; }
    this.syncing = true;
    this.setStatus("syncing…");
    try {
      const client = new JmapClient({ baseUrl: this.settings.baseUrl, user: this.settings.username, pass: this.settings.password });
      const engine = new SyncEngine(
        this.app.vault.adapter,
        client,
        { syncRoot: this.settings.syncRoot, remoteRootName: this.settings.remoteRootName, allowLocalDeletes: this.settings.allowLocalDeletes },
        this.syncState,
        async (s) => { this.syncState = s; await this.persist(); },
      );
      const r = await engine.sync();
      this.lastReport = r;
      const summary = `↓${r.pulled} +${r.pushedNew} ~${r.pushedEdit} -${r.deletedRemote} !${r.conflicts}`;
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
}

class JyncSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: JyncPlugin) { super(app, plugin); }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Jync — JMAP FileNode sync" });

    const s = this.plugin.settings;
    const save = async () => this.plugin.persist();

    new Setting(containerEl).setName("Server URL").setDesc("Stalwart JMAP origin")
      .addText((t) => t.setValue(s.baseUrl).onChange(async (v) => { s.baseUrl = v.trim(); await save(); }));
    new Setting(containerEl).setName("Username")
      .addText((t) => t.setValue(s.username).onChange(async (v) => { s.username = v.trim(); await save(); }));
    new Setting(containerEl).setName("Password / token").setDesc("Stored in plaintext under ignis — prefer a scoped token")
      .addText((t) => { t.inputEl.type = "password"; t.setValue(s.password).onChange(async (v) => { s.password = v; await save(); }); });

    new Setting(containerEl).setName("Sync root (vault folder)").setDesc("Only this subtree is synced")
      .addText((t) => t.setValue(s.syncRoot).onChange(async (v) => { s.syncRoot = v.trim().replace(/^\/+|\/+$/g, ""); await save(); }));
    new Setting(containerEl).setName("Remote root folder name")
      .addText((t) => t.setValue(s.remoteRootName).onChange(async (v) => { s.remoteRootName = v.trim(); await save(); }));

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
