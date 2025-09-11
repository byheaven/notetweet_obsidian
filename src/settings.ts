import {App, ButtonComponent, Modal, Notice, PluginSettingTab, Setting, TextComponent} from "obsidian";
import NoteTweet from "./main";
import { SecureModeModal } from "./Modals/SecureModeSettingModal/SecureModeModal";
import {ScheduledTweetsModal} from "./Modals/ScheduledTweetsModal";

export interface TwitterAccount {
  id: string;
  name: string; // User-customizable account name
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessTokenSecret: string;
  isActive: boolean;
  
  // Account-specific settings
  postTweetTag: string;
  autoSplitTweets: boolean;
  secureMode: boolean;
  
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
}

export const DEFAULT_SETTINGS: NoteTweetSettings = Object.freeze({
  // Multi-account support
  accounts: [],
  lastUsedAccountId: "",
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
}, accountSettings?: Partial<Pick<TwitterAccount, 'postTweetTag' | 'autoSplitTweets' | 'secureMode' | 'scheduling'>>): TwitterAccount {
  return {
    id: generateAccountId(),
    name: name.trim(),
    apiKey: credentials.apiKey,
    apiSecret: credentials.apiSecret,
    accessToken: credentials.accessToken,
    accessTokenSecret: credentials.accessTokenSecret,
    isActive: false,
    
    // Account-specific settings with defaults
    postTweetTag: accountSettings?.postTweetTag || "",
    autoSplitTweets: accountSettings?.autoSplitTweets ?? true,
    secureMode: accountSettings?.secureMode || false,
    
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
      this.statusIndicator.innerHTML = `<strong>Plugin Status:</strong> ${
        this.plugin.twitterHandler.isConnectedToTwitter
          ? "✅ Plugin connected to Twitter."
          : "🛑 Plugin not connected to Twitter."
      }`;
    }
  }

  async updateConnectionStatus() {
    this.checkStatus("⏳ Verifying Twitter credentials...");
    const connected = await this.plugin.connectToTwitterWithPlainSettings();
    const currentAccount = this.plugin.getCurrentAccount();
    if (connected === undefined && currentAccount?.secureMode) {
      this.checkStatus("🔒 Secure mode enabled.");
    } else {
      this.checkStatus();
    }
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
    const accountsSection = containerEl.createDiv("notetweet-account-selector-section");
    accountsSection.createEl("h3", { text: "Twitter Accounts" });
    
    const accounts = this.plugin.settings.accounts;
    
    if (!accounts || accounts.length === 0) {
      // No accounts - show add button
      accountsSection.createEl("p", { 
        text: "No Twitter accounts configured. Add your first account to get started.",
        cls: "setting-item-description"
      });
      
      new Setting(accountsSection)
        .setName("Add First Account")
        .setDesc("Add a new Twitter account with custom name")
        .addButton(button => 
          button
            .setButtonText("Add Account")
            .setCta()
            .onClick(() => this.showAddAccountModal())
        );
      return;
    }

    // Account selection dropdown
    new Setting(accountsSection)
      .setName("Select Account to Configure")
      .setDesc("Choose which Twitter account to view and edit settings for")
      .addDropdown(dropdown => {
        // Add default option
        dropdown.addOption("", "-- Select an account --");
        
        // Add all accounts
        accounts.forEach(account => {
          dropdown.addOption(account.id, account.name);
        });
        
        // Set current selection
        if (this.selectedAccountId) {
          dropdown.setValue(this.selectedAccountId);
        } else {
          // Auto-select last used account if available
          const lastUsedAccount = this.plugin.getCurrentAccount();
          if (lastUsedAccount) {
            this.selectedAccountId = lastUsedAccount.id;
            dropdown.setValue(this.selectedAccountId);
          }
        }
        
        dropdown.onChange((selectedId) => {
          this.selectedAccountId = selectedId || null;
          this.display(); // Refresh to show/hide account settings
        });
        
        this.accountSelector = dropdown.selectEl;
      });
      
    // Add new account button
    new Setting(accountsSection)
      .setName("Manage Accounts")
      .addButton(button => 
        button
          .setButtonText("Add New Account")
          .onClick(() => this.showAddAccountModal())
      )
      .addButton(button => {
        if (this.selectedAccountId) {
          button
            .setButtonText("Remove Selected Account")
            .setWarning()
            .onClick(() => this.confirmRemoveAccount(this.getSelectedAccount()!));
        } else {
          button.setDisabled(true).setButtonText("Select Account First");
        }
      });
  }
  
  private getSelectedAccount(): TwitterAccount | null {
    if (!this.selectedAccountId) return null;
    return this.plugin.getAccountById(this.selectedAccountId);
  }
  
  private addAccountSpecificSettings(containerEl: HTMLElement) {
    const account = this.getSelectedAccount();
    if (!account) return;
    
    const accountSection = containerEl.createDiv("notetweet-account-specific-settings");
    accountSection.createEl("h3", { text: `Settings for: ${account.name}` });
    
    // Account connection status
    this.addConnectionStatus(accountSection, account);
    
    // Account name setting
    this.addAccountNameSetting(accountSection, account);
    
    // API credentials
    this.addAccountCredentials(accountSection, account);
    
    // Account-specific settings
    this.addAccountTweetTagSetting(accountSection, account);
    this.addAccountAutoSplitSetting(accountSection, account);
    this.addAccountSecureModeSetting(accountSection, account);
    this.addAccountSchedulerSetting(accountSection, account);
  }
  
  private addGlobalSettings(containerEl: HTMLElement) {
    // Currently no global settings - all settings are account-specific
    // This method is kept for future global settings if needed
  }

  private addConnectionStatus(container: HTMLElement, account: TwitterAccount) {
    const statusEl = container.createEl("div", { cls: "notetweet-connection-status" });
    
    // Use saved connection status from account
    let statusText = '';
    let statusColor = '';
    
    switch (account.connectionStatus) {
      case 'connected':
        statusText = '✅ Connected';
        statusColor = '#28a745';
        break;
      case 'failed':
        statusText = `❌ Failed${account.lastError ? ': ' + account.lastError : ''}`;
        statusColor = '#dc3545';
        break;
      case 'untested':
      default:
        statusText = '🔍 Not tested';
        statusColor = '#6c757d';
        break;
    }
    
    // Add last test time if available
    let lastTestText = '';
    if (account.lastConnectionTest) {
      const lastTestDate = new Date(account.lastConnectionTest);
      lastTestText = ` <small>(Last tested: ${lastTestDate.toLocaleString()})</small>`;
    }
    
    statusEl.innerHTML = `
      <strong>Connection Status:</strong> 
      <span style="color: ${statusColor}">
        ${statusText}
      </span>
      ${lastTestText}
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
              
              // Update status display based on updated account status
              const lastTestDate = new Date(account.lastConnectionTest || Date.now());
              const lastTestText = ` <small>(Last tested: ${lastTestDate.toLocaleString()})</small>`;
              
              if (connected) {
                statusEl.innerHTML = `<strong>Connection Status:</strong> <span style="color: #28a745">✅ Connected</span>${lastTestText}`;
                button.setButtonText("✅ Connected");
              } else {
                const errorText = account.lastError ? `: ${account.lastError}` : '';
                statusEl.innerHTML = `<strong>Connection Status:</strong> <span style="color: #dc3545">❌ Failed${errorText}</span>${lastTestText}`;
                button.setButtonText("❌ Failed");
              }
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
  
  private addAccountNameSetting(container: HTMLElement, account: TwitterAccount) {
    let nameChangeTimeout: NodeJS.Timeout;
    
    new Setting(container)
      .setName("Account Name")
      .setDesc("Custom name for this account")
      .addText(text => 
        text
          .setPlaceholder("Enter account name")
          .setValue(account.name)
          .onChange(async (value) => {
            // Clear previous timeout
            if (nameChangeTimeout) {
              clearTimeout(nameChangeTimeout);
            }
            
            // Validate immediately for visual feedback
            const error = validateAccountName(value, this.plugin.settings.accounts, account.id);
            if (error) {
              text.inputEl.style.borderColor = "#dc3545";
              text.inputEl.title = error;
            } else {
              text.inputEl.style.borderColor = "";
              text.inputEl.title = "";
            }
            
            // Delay save and refresh by 1 second
            nameChangeTimeout = setTimeout(async () => {
              if (!error && value.trim() !== account.name) {
                account.name = value.trim();
                await this.plugin.saveSettings();
                
                // Update dropdown text but don't refresh entire page
                if (this.accountSelector) {
                  const option = this.accountSelector.querySelector(`option[value="${account.id}"]`) as HTMLOptionElement;
                  if (option) {
                    option.textContent = account.name;
                  }
                }
              }
            }, 1000);
          })
      );
  }
  
  private addAccountCredentials(container: HTMLElement, account: TwitterAccount) {
    this.addAccountCredentialSetting(container, account, "API Key", "apiKey");
    this.addAccountCredentialSetting(container, account, "API Secret", "apiSecret");
    this.addAccountCredentialSetting(container, account, "Access Token", "accessToken");
    this.addAccountCredentialSetting(container, account, "Access Token Secret", "accessTokenSecret");
  }
  
  private addAccountTweetTagSetting(container: HTMLElement, account: TwitterAccount) {
    let tagChangeTimeout: NodeJS.Timeout;
    
    new Setting(container)
      .setName("Tweet Tag")
      .setDesc("Tag appended to tweets posted from this account")
      .addText(text =>
        text
          .setPlaceholder("Tag to append")
          .setValue(account.postTweetTag)
          .onChange(async (value) => {
            // Clear previous timeout
            if (tagChangeTimeout) {
              clearTimeout(tagChangeTimeout);
            }
            
            // Update immediately for UI responsiveness
            account.postTweetTag = value;
            
            // Delay save by 500ms
            tagChangeTimeout = setTimeout(async () => {
              await this.plugin.saveSettings();
            }, 500);
          })
      );
  }
  
  private addAccountAutoSplitSetting(container: HTMLElement, account: TwitterAccount) {
    new Setting(container)
      .setName("Auto-split tweets")
      .setDesc("Automatically split tweets at 280 characters for this account. Disable to allow longer tweets (requires paid X plan).")
      .addToggle(toggle => 
        toggle.setTooltip('Toggle auto-splitting tweets')
          .setValue(account.autoSplitTweets)
          .onChange(async (value) => {
            account.autoSplitTweets = value;
            await this.plugin.saveSettings();
          })
      );
  }
  
  private addAccountSecureModeSetting(container: HTMLElement, account: TwitterAccount) {
    new Setting(container)
      .setName("Secure Mode")
      .setDesc("Require password to unlock usage for this account. Scheduler not supported.")
      .addToggle(toggle =>
        toggle
          .setTooltip("Toggle Secure Mode")
          .setValue(account.secureMode)
          .onChange(async (value) => {
            if (value === account.secureMode) return;
            
            // TODO: Implement secure mode modal for individual accounts
            account.secureMode = value;
            await this.plugin.saveSettings();
          })
      );
  }

  private addAccountCredentialSetting(
    container: HTMLElement, 
    account: TwitterAccount, 
    name: string, 
    key: keyof TwitterAccount
  ) {
    let credentialChangeTimeout: NodeJS.Timeout;
    
    new Setting(container)
      .setName(name)
      .setDesc(`Enter your Twitter ${name.toLowerCase()}`)
      .addText(text => {
        this.setPasswordOnBlur(text.inputEl);
        text
          .setPlaceholder(`Enter ${name.toLowerCase()}`)
          .setValue(account[key] as string)
          .onChange(async (value) => {
            // Clear previous timeout
            if (credentialChangeTimeout) {
              clearTimeout(credentialChangeTimeout);
            }
            
            // Update the account object immediately for UI responsiveness
            (account[key] as string) = value;
            
            // Delay save by 500ms for credentials (faster than name)
            credentialChangeTimeout = setTimeout(async () => {
              await this.plugin.saveSettings();
            }, 500);
          });
      });
  }

  private async showAddAccountModal() {
    const modal = new AddAccountModal(this.app, this.plugin, (account) => {
      this.plugin.addAccount(account);
      this.display(); // Refresh to show new account
    });
    modal.open();
  }

  private confirmRemoveAccount(account: TwitterAccount) {
    const modal = new ConfirmModal(
      this.app,
      "Remove Account", 
      `Are you sure you want to remove the account "${account.name}"? This action cannot be undone.`,
      () => {
        this.plugin.removeAccount(account.id);
        this.display(); // Refresh to hide removed account
      }
    );
    modal.open();
  }




    private addAccountSchedulerSetting(containerEl: HTMLElement, account: TwitterAccount) {
        // Ensure scheduling object exists
        if (!account.scheduling) {
            account.scheduling = {
                enabled: false,
                url: "",
                password: "",
                cronStrings: []
            };
        }
        
        new Setting(containerEl)
            .setName("Scheduling")
            .setDesc("Enable scheduling tweets for this account. This will require some setup!")
            .addToggle(toggle =>
                toggle.setTooltip('Toggle tweet scheduling for this account')
                    .setValue(account.scheduling?.enabled || false)
                    .onChange(async value => {
                        if (!account.scheduling) {
                            account.scheduling = {
                                enabled: false,
                                url: "",
                                password: "",
                                cronStrings: []
                            };
                        }
                        account.scheduling.enabled = value;
                        await this.plugin.saveSettings();
                        this.display();
                    })
            );

        new Setting(containerEl)
            .setName('Scheduled tweets')
            .setDesc('View and manage scheduled tweets for this account')
            .addButton(button => button
                .setButtonText("Open")
                .onClick(async () => {
                    const scheduler = this.plugin.getSchedulerForAccount(account.id);
                    if (scheduler) {
                        new ScheduledTweetsModal(this.app, scheduler).open();
                    } else {
                        new Notice("Scheduler not available for this account");
                    }
                }));

        if (account.scheduling?.enabled) {
            new Setting(containerEl)
            .setName("Scheduler URL")
            .setDesc("Endpoint URL for this account's scheduler")
            .addText(text =>
                text.setPlaceholder("Scheduler URL")
                    .setValue(account.scheduling?.url || '')
                    .onChange(async value => {
                        if (!account.scheduling) {
                            account.scheduling = {
                                enabled: false,
                                url: "",
                                password: "",
                                cronStrings: []
                            };
                        }
                        account.scheduling.url = value;
                        await this.plugin.saveSettings();
                    })
            );

            new Setting(containerEl)
                .setName("Scheduler password")
                .setDesc("Password set for this account's scheduler")
                .addText(text => {
                    this.setPasswordOnBlur(text.inputEl);
                    text.setPlaceholder('Password')
                        .setValue(account.scheduling?.password || '')
                        .onChange(async value => {
                            if (!account.scheduling) {
                                account.scheduling = {
                                    enabled: false,
                                    url: "",
                                    password: "",
                                    cronStrings: []
                                };
                            }
                            account.scheduling.password = value;
                            await this.plugin.saveSettings();
                        })
                    }
                );

        }
    }

    private setPasswordOnBlur(el: HTMLInputElement) {
        el.addEventListener('focus', () => {
            el.type = "text";
        });

        el.addEventListener('blur', () => {
            el.type = "password";
        });

        el.type = "password";
    }
}

// Modal for adding new accounts
class AddAccountModal extends Modal {
  private nameInput: HTMLInputElement;
  private apiKeyInput: HTMLInputElement;
  private apiSecretInput: HTMLInputElement;
  private accessTokenInput: HTMLInputElement;
  private accessTokenSecretInput: HTMLInputElement;
  private onSubmit: (account: TwitterAccount) => void;

  constructor(app: App, private plugin: NoteTweet, onSubmit: (account: TwitterAccount) => void) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    
    contentEl.createEl("h2", { text: "Add Twitter Account" });
    contentEl.createEl("p", { 
      text: "Enter a custom name and your Twitter API credentials for this account.",
      cls: "setting-item-description"
    });

    // Account name input
    const nameContainer = contentEl.createDiv();
    nameContainer.createEl("label", { text: "Account Name *" });
    this.nameInput = nameContainer.createEl("input", {
      type: "text",
      placeholder: "e.g., Personal Account, Work Account"
    });
    this.nameInput.style.width = "100%";
    this.nameInput.style.marginBottom = "10px";

    // API credentials inputs
    const credentialsContainer = contentEl.createDiv();
    credentialsContainer.createEl("h3", { text: "Twitter API Credentials" });

    this.apiKeyInput = this.createCredentialInput(credentialsContainer, "API Key");
    this.apiSecretInput = this.createCredentialInput(credentialsContainer, "API Secret", true);
    this.accessTokenInput = this.createCredentialInput(credentialsContainer, "Access Token", true);
    this.accessTokenSecretInput = this.createCredentialInput(credentialsContainer, "Access Token Secret", true);

    // Buttons
    const buttonContainer = contentEl.createDiv();
    buttonContainer.style.display = "flex";
    buttonContainer.style.gap = "10px";
    buttonContainer.style.marginTop = "20px";

    const addButton = buttonContainer.createEl("button", { text: "Add Account" });
    addButton.classList.add("mod-cta");
    addButton.addEventListener("click", () => this.handleSubmit());

    const cancelButton = buttonContainer.createEl("button", { text: "Cancel" });
    cancelButton.addEventListener("click", () => this.close());

    this.nameInput.focus();
  }

  private createCredentialInput(container: HTMLElement, label: string, isPassword: boolean = false): HTMLInputElement {
    const inputContainer = container.createDiv();
    inputContainer.createEl("label", { text: label + " *" });
    const input = inputContainer.createEl("input", {
      type: isPassword ? "password" : "text",
      placeholder: `Enter ${label.toLowerCase()}`
    });
    input.style.width = "100%";
    input.style.marginBottom = "10px";

    if (isPassword) {
      input.addEventListener('focus', () => input.type = "text");
      input.addEventListener('blur', () => input.type = "password");
    }

    return input;
  }

  private async handleSubmit() {
    const name = this.nameInput.value.trim();
    const apiKey = this.apiKeyInput.value.trim();
    const apiSecret = this.apiSecretInput.value.trim();
    const accessToken = this.accessTokenInput.value.trim();
    const accessTokenSecret = this.accessTokenSecretInput.value.trim();

    // Validate inputs
    if (!name) {
      new Notice("Please enter an account name");
      this.nameInput.focus();
      return;
    }

    const nameError = validateAccountName(name, this.plugin.settings.accounts);
    if (nameError) {
      new Notice(nameError);
      this.nameInput.focus();
      return;
    }

    if (!apiKey || !apiSecret || !accessToken || !accessTokenSecret) {
      new Notice("Please fill in all API credentials");
      return;
    }

    // Create the account
    const account = createAccount(name, {
      apiKey,
      apiSecret,
      accessToken,
      accessTokenSecret
    });

    // Test connection
    const testButton = this.contentEl.querySelector("button.mod-cta") as HTMLButtonElement;
    testButton.textContent = "Testing connection...";
    testButton.disabled = true;

    try {
      const connected = await this.plugin.twitterHandler.connectToAccount(account);
      if (connected) {
        this.onSubmit(account);
        new Notice(`✅ Account "${account.name}" added and connected successfully!`);
        this.close();
      } else {
        // Show specific error from the account's lastError field
        const errorMessage = account.lastError || "Please check your credentials.";
        new Notice(`❌ Failed to connect account "${account.name}": ${errorMessage}`);
        testButton.textContent = "Add Account";
        testButton.disabled = false;
      }
    } catch (error) {
      new Notice(`❌ Error connecting to Twitter: ${error.message}`);
      testButton.textContent = "Add Account";
      testButton.disabled = false;
    }
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

// Simple confirmation modal
class ConfirmModal extends Modal {
  constructor(
    app: App,
    private title: string,
    private message: string,
    private onConfirm: () => void
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    
    contentEl.createEl("h2", { text: this.title });
    contentEl.createEl("p", { text: this.message });

    const buttonContainer = contentEl.createDiv();
    buttonContainer.style.display = "flex";
    buttonContainer.style.gap = "10px";
    buttonContainer.style.marginTop = "20px";

    const confirmButton = buttonContainer.createEl("button", { text: "Remove" });
    confirmButton.classList.add("mod-warning");
    confirmButton.addEventListener("click", () => {
      this.onConfirm();
      this.close();
    });

    const cancelButton = buttonContainer.createEl("button", { text: "Cancel" });
    cancelButton.addEventListener("click", () => this.close());
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}
