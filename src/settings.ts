import {App, ButtonComponent, Modal, Notice, PluginSettingTab, Setting, TextComponent} from "obsidian";
import NoteTweet from "./main";
import {ScheduledTweetsModal} from "./Modals/ScheduledTweetsModal";

export interface TwitterAccount {
  id: string;
  name: string; // User-customizable account name
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessTokenSecret: string;

  // Account-specific settings
  postTweetTag: string;
  autoSplitTweets: boolean;

  // Scheduling settings (per account)
  scheduling: {
    enabled: boolean;
    url: string;
    password: string;
    cronStrings: string[];
  };

  // Connection status tracking
  connectionStatus: 'connected' | 'failed' | 'untested';
  lastConnectionTest?: number; // Timestamp of last test
  lastError?: string; // Last error message if failed
}

export interface NoteTweetSettings {
  // Multi-account support
  accounts: TwitterAccount[];
  lastUsedAccountId: string;

  // Migration tracking
  migrationVersion?: number; // Track which migrations have been completed
}

export const DEFAULT_SETTINGS: NoteTweetSettings = Object.freeze({
  // Multi-account support
  accounts: [],
  lastUsedAccountId: "",
  migrationVersion: 0,
});

// Utility functions for account management
export function generateAccountId(): string {
  return Date.now().toString() + Math.random().toString(36).substr(2, 9);
}

export function createAccount(name: string, credentials: {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessTokenSecret: string;
}, accountSettings?: Partial<Pick<TwitterAccount, 'postTweetTag' | 'autoSplitTweets' | 'scheduling'>>): TwitterAccount {
  return {
    id: generateAccountId(),
    name: name.trim(),
    apiKey: credentials.apiKey,
    apiSecret: credentials.apiSecret,
    accessToken: credentials.accessToken,
    accessTokenSecret: credentials.accessTokenSecret,

    // Account-specific settings with defaults
    postTweetTag: accountSettings?.postTweetTag || "",
    autoSplitTweets: accountSettings?.autoSplitTweets ?? true,

    // Scheduling settings with defaults
    scheduling: accountSettings?.scheduling || {
      enabled: false,
      url: "",
      password: "",
      cronStrings: []
    },

    // Connection status - new accounts are untested
    connectionStatus: 'untested',
    lastConnectionTest: undefined,
    lastError: undefined
  };
}

export function validateAccountName(name: string, accounts: TwitterAccount[], excludeId?: string): string | null {
  const trimmedName = name.trim();
  if (!trimmedName) {
    return "Account name cannot be empty";
  }
  if (trimmedName.length > 50) {
    return "Account name must be 50 characters or less";
  }

  const duplicateAccount = accounts.find(account =>
    account.name.toLowerCase() === trimmedName.toLowerCase() &&
    account.id !== excludeId
  );
  if (duplicateAccount) {
    return "An account with this name already exists";
  }

  return null;
}

export class NoteTweetSettingsTab extends PluginSettingTab {
  plugin: NoteTweet;
  private statusIndicator: HTMLElement;
  private selectedAccountId: string | null = null;
  private accountSelector: HTMLSelectElement;

  constructor(app: App, plugin: NoteTweet) {
    super(app, plugin);
    this.plugin = plugin;
  }

  checkStatus(message?: string) {
    if (message) {
      this.statusIndicator.innerHTML = `<strong>Plugin Status:</strong> ${message}`;
    } else {
      // Check the saved account status instead of runtime connection status
      const currentAccount = this.plugin.getCurrentAccount();
      const isConnected = currentAccount?.connectionStatus === 'connected';

      this.statusIndicator.innerHTML = `<strong>Plugin Status:</strong> ${
        isConnected
          ? "✅ Plugin connected to Twitter."
          : "🛑 Plugin not connected to Twitter."
      }`;
    }
  }

  async updateConnectionStatus() {
    this.checkStatus("⏳ Verifying Twitter credentials...");
    const connected = await this.plugin.connectToTwitterWithPlainSettings();
    this.checkStatus();
  }

  display(): void {
    let { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "NoteTweet" });
    this.statusIndicator = containerEl.createEl("p");
    this.checkStatus();

    // Account selector section
    this.addAccountSelectorSection(containerEl);

    // Account-specific settings (shown when an account is selected)
    if (this.selectedAccountId) {
      this.addAccountSpecificSettings(containerEl);
    }

    // Global settings (always shown)
    this.addGlobalSettings(containerEl);
  }

  private addAccountSelectorSection(containerEl: HTMLElement) {
    const accounts = this.plugin.settings.accounts || [];

    // Account management header
    containerEl.createEl("h3", { text: "Manage Accounts" });

    // Account selector dropdown
    const selectorSetting = new Setting(containerEl)
      .setName("Select Account")
      .setDesc("Choose an account to view or edit its settings");

    selectorSetting.addDropdown(dropdown => {
      // Add "Select an account" option
      dropdown.addOption("", "-- Select an account --");

      // Add all accounts
      for (const account of accounts) {
        const statusEmoji = account.connectionStatus === 'connected' ? '✅' :
                           account.connectionStatus === 'failed' ? '❌' : '🔍';
        dropdown.addOption(account.id, `${statusEmoji} ${account.name}`);
      }

      // Set current selection
      dropdown.setValue(this.selectedAccountId || "");

      dropdown.onChange(value => {
        this.selectedAccountId = value || null;
        this.display();
      });

      this.accountSelector = dropdown.selectEl;
    });

    // Add account button
    selectorSetting.addButton(button =>
      button
        .setButtonText("Add Account")
        .setCta()
        .onClick(() => {
          new AddAccountModal(this.app, this.plugin, (account) => {
            this.plugin.addAccount(account);
            this.plugin.saveSettings();
            this.selectedAccountId = account.id;
            this.display();
          }).open();
        })
    );
  }

  private addAccountSpecificSettings(containerEl: HTMLElement) {
    const account = this.plugin.getAccountById(this.selectedAccountId!);
    if (!account) return;

    containerEl.createEl("h3", { text: `Account: ${account.name}` });

    // Connection status display
    this.addConnectionStatus(containerEl, account);

    // Account credentials
    this.addCredentialSettings(containerEl, account);

    // Account-specific settings
    this.addAccountSettings(containerEl, account);

    // Scheduling settings
    this.addSchedulingSettings(containerEl, account);

    // Danger zone
    this.addDangerZone(containerEl, account);
  }

  private addConnectionStatus(container: HTMLElement, account: TwitterAccount) {
    const statusEl = container.createEl("div", { cls: "notetweet-connection-status" });

    let statusText = "";
    let statusColor = "";

    switch (account.connectionStatus) {
      case 'connected':
        statusText = "✅ Connected";
        statusColor = "#28a745";
        break;
      case 'failed':
        statusText = `❌ Failed${account.lastError ? `: ${account.lastError}` : ''}`;
        statusColor = "#dc3545";
        break;
      case 'untested':
      default:
        statusText = "🔍 Not tested";
        statusColor = "#6c757d";
        break;
    }

    const lastTestText = account.lastConnectionTest
      ? `Last tested: ${new Date(account.lastConnectionTest).toLocaleString()}`
      : "Never tested";

    statusEl.innerHTML = `
      <strong>Connection Status:</strong> <span style="color: ${statusColor}">${statusText}</span><br>
      <small style="color: #6c757d">${lastTestText}</small>
    `;

    // Test connection button
    new Setting(container)
      .setName("Test Connection")
      .setDesc("Test the connection to Twitter with this account")
      .addButton(button =>
        button
          .setButtonText("Test Connection")
          .onClick(async () => {
            button.setButtonText("Testing...");
            button.setDisabled(true);

            try {
              const connected = await this.plugin.twitterHandler.connectToAccount(account);

              if (connected) {
                statusEl.innerHTML = `<strong>Connection Status:</strong> <span style="color: #28a745">✅ Connected</span>`;
                button.setButtonText("✅ Connected");
              } else {
                const errorMsg = account.lastError || "Connection failed";
                statusEl.innerHTML = `<strong>Connection Status:</strong> <span style="color: #dc3545">❌ Failed: ${errorMsg}</span>`;
                button.setButtonText("❌ Failed");
              }

              this.checkStatus();
            } catch (e) {
              statusEl.innerHTML = `<strong>Connection Status:</strong> <span style="color: #dc3545">❌ Error</span>`;
              button.setButtonText("❌ Error");
            }

            setTimeout(() => {
              button.setButtonText("Test Connection");
              button.setDisabled(false);
            }, 2000);
          })
      );
  }

  private addCredentialSettings(container: HTMLElement, account: TwitterAccount) {
    new Setting(container)
      .setName("API Key")
      .setDesc("Twitter API key")
      .addText(text => {
        this.setPasswordOnBlur(text.inputEl);
        text
          .setPlaceholder("Enter API Key")
          .setValue(account.apiKey)
          .onChange(async value => {
            account.apiKey = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(container)
      .setName("API Secret")
      .setDesc("Twitter API Secret")
      .addText(text => {
        this.setPasswordOnBlur(text.inputEl);
        text
          .setPlaceholder("Enter API Secret")
          .setValue(account.apiSecret)
          .onChange(async value => {
            account.apiSecret = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(container)
      .setName("Access Token")
      .setDesc("Twitter Access Token")
      .addText(text => {
        this.setPasswordOnBlur(text.inputEl);
        text
          .setPlaceholder("Enter Access Token")
          .setValue(account.accessToken)
          .onChange(async value => {
            account.accessToken = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(container)
      .setName("Access Token Secret")
      .setDesc("Twitter Access Token Secret")
      .addText(text => {
        this.setPasswordOnBlur(text.inputEl);
        text
          .setPlaceholder("Enter Access Token Secret")
          .setValue(account.accessTokenSecret)
          .onChange(async value => {
            account.accessTokenSecret = value;
            await this.plugin.saveSettings();
          });
      });
  }

  private addAccountSettings(container: HTMLElement, account: TwitterAccount) {
    new Setting(container)
      .setName("Tweet Tag")
      .setDesc("Appended to your tweets to indicate that it has been posted")
      .addText(text =>
        text
          .setPlaceholder("Tag to append")
          .setValue(account.postTweetTag)
          .onChange(async value => {
            account.postTweetTag = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(container)
      .setName("Auto-split tweets")
      .setDesc("Automatically split tweets at 280 characters")
      .addToggle(toggle =>
        toggle
          .setValue(account.autoSplitTweets)
          .onChange(async value => {
            account.autoSplitTweets = value;
            await this.plugin.saveSettings();
          })
      );
  }

  private addSchedulingSettings(container: HTMLElement, account: TwitterAccount) {
    new Setting(container)
      .setName("Scheduling")
      .setDesc("Enable scheduling tweets for this account")
      .addToggle(toggle =>
        toggle
          .setValue(account.scheduling?.enabled || false)
          .onChange(async value => {
            if (!account.scheduling) {
              account.scheduling = { enabled: false, url: "", password: "", cronStrings: [] };
            }
            account.scheduling.enabled = value;
            await this.plugin.saveSettings();
            this.display();
          })
      );

    if (account.scheduling?.enabled) {
      new Setting(container)
        .setName("Scheduler URL")
        .setDesc("Endpoint URL for the scheduler")
        .addText(text =>
          text
            .setPlaceholder("Scheduler URL")
            .setValue(account.scheduling.url)
            .onChange(async value => {
              account.scheduling.url = value;
              await this.plugin.saveSettings();
            })
        );

      new Setting(container)
        .setName("Scheduler Password")
        .setDesc("Password for the scheduler")
        .addText(text => {
          this.setPasswordOnBlur(text.inputEl);
          text
            .setPlaceholder("Password")
            .setValue(account.scheduling.password)
            .onChange(async value => {
              account.scheduling.password = value;
              await this.plugin.saveSettings();
            });
        });
    }

    new Setting(container)
      .setName("Scheduled Tweets")
      .setDesc("View and manage scheduled tweets")
      .addButton(button =>
        button
          .setButtonText("Open")
          .onClick(() => {
            const scheduler = this.plugin.getSchedulerForAccount(account.id);
            if (scheduler) {
              new ScheduledTweetsModal(this.app, scheduler).open();
            } else {
              new Notice("Scheduler not available for this account");
            }
          })
      );
  }

  private addDangerZone(container: HTMLElement, account: TwitterAccount) {
    container.createEl("h4", { text: "Danger Zone", cls: "notetweet-danger-zone" });

    new Setting(container)
      .setName("Rename Account")
      .setDesc("Change the display name for this account")
      .addText(text =>
        text
          .setPlaceholder("New name")
          .setValue(account.name)
          .onChange(async value => {
            const error = validateAccountName(value, this.plugin.settings.accounts, account.id);
            if (!error) {
              account.name = value.trim();
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(container)
      .setName("Delete Account")
      .setDesc("Permanently remove this account")
      .addButton(button =>
        button
          .setButtonText("Delete")
          .setWarning()
          .onClick(async () => {
            const confirmed = confirm(`Are you sure you want to delete the account "${account.name}"? This cannot be undone.`);
            if (confirmed) {
              this.plugin.removeAccount(account.id);
              await this.plugin.saveSettings();
              this.selectedAccountId = null;
              this.display();
              new Notice(`Account "${account.name}" deleted`);
            }
          })
      );
  }

  private addGlobalSettings(containerEl: HTMLElement) {
    containerEl.createEl("h3", { text: "About" });

    new Setting(containerEl)
      .setName("NoteTweet")
      .setDesc("Post tweets directly from Obsidian");
  }

  private setPasswordOnBlur(el: HTMLInputElement) {
    el.addEventListener("focus", () => {
      el.type = "text";
    });

    el.addEventListener("blur", () => {
      el.type = "password";
    });

    el.type = "password";
  }
}

// Modal for adding a new account
class AddAccountModal extends Modal {
  private plugin: NoteTweet;
  private onSubmit: (account: TwitterAccount) => void;

  constructor(app: App, plugin: NoteTweet, onSubmit: (account: TwitterAccount) => void) {
    super(app);
    this.plugin = plugin;
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Add Twitter Account" });

    let name = "";
    let apiKey = "";
    let apiSecret = "";
    let accessToken = "";
    let accessTokenSecret = "";

    new Setting(contentEl)
      .setName("Account Name")
      .setDesc("A friendly name to identify this account")
      .addText(text =>
        text
          .setPlaceholder("My Twitter Account")
          .onChange(value => { name = value; })
      );

    new Setting(contentEl)
      .setName("API Key")
      .addText(text => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("Enter API Key")
          .onChange(value => { apiKey = value; });
      });

    new Setting(contentEl)
      .setName("API Secret")
      .addText(text => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("Enter API Secret")
          .onChange(value => { apiSecret = value; });
      });

    new Setting(contentEl)
      .setName("Access Token")
      .addText(text => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("Enter Access Token")
          .onChange(value => { accessToken = value; });
      });

    new Setting(contentEl)
      .setName("Access Token Secret")
      .addText(text => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("Enter Access Token Secret")
          .onChange(value => { accessTokenSecret = value; });
      });

    new Setting(contentEl)
      .addButton(button =>
        button
          .setButtonText("Add Account")
          .setCta()
          .onClick(async () => {
            // Validate
            const nameError = validateAccountName(name, this.plugin.settings.accounts);
            if (nameError) {
              new Notice(nameError);
              return;
            }

            if (!apiKey || !apiSecret || !accessToken || !accessTokenSecret) {
              new Notice("All credential fields are required");
              return;
            }

            // Create account
            const account = createAccount(name, {
              apiKey,
              apiSecret,
              accessToken,
              accessTokenSecret
            });

            // Test connection
            button.setButtonText("Testing connection...");
            button.setDisabled(true);

            try {
              const connected = await this.plugin.twitterHandler.connectToAccount(account);
              if (connected) {
                this.onSubmit(account);
                new Notice(`✅ Account "${account.name}" added and connected successfully!`);
                this.close();
              } else {
                const errorMessage = account.lastError || "Please check your credentials.";
                new Notice(`❌ Failed to connect: ${errorMessage}`);
                button.setButtonText("Add Account");
                button.setDisabled(false);
              }
            } catch (error) {
              new Notice(`❌ Error: ${error.message}`);
              button.setButtonText("Add Account");
              button.setDisabled(false);
            }
          })
      );
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}
