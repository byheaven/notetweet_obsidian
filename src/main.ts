import {Editor, MarkdownView, Notice, Plugin, TFile} from "obsidian";
import {TwitterHandler} from "./TwitterHandler";
import {DEFAULT_SETTINGS, NoteTweetSettings, NoteTweetSettingsTab, createAccount, TwitterAccount} from "./settings";
import {TweetsPostedModal} from "./Modals/TweetsPostedModal/TweetsPostedModal";
import {TweetErrorModal} from "./Modals/TweetErrorModal";
import {log} from "./ErrorModule/logManager";
import {ConsoleErrorLogger} from "./ErrorModule/consoleErrorLogger";
import {GuiLogger} from "./ErrorModule/guiLogger";
import {NoteTweetScheduler} from "./scheduling/NoteTweetScheduler";
import {SelfHostedScheduler} from "./scheduling/SelfHostedScheduler";
import {NewTweetModal} from "./Modals/NewTweetModal";
import {ITweet} from "./Types/ITweet";
import {IScheduledTweet} from "./Types/IScheduledTweet";
import {Tweet} from "./Types/Tweet";
import {ScheduledTweet} from "./Types/ScheduledTweet";
import {TweetV2PostTweetResult} from "twitter-api-v2";

const WELCOME_MESSAGE: string = "Loading NoteTweet🐦. Thanks for installing.";
const UNLOAD_MESSAGE: string = "Unloaded NoteTweet.";

export default class NoteTweet extends Plugin {
  settings: NoteTweetSettings;
  schedulers: Map<string, NoteTweetScheduler> = new Map(); // Map of accountId to scheduler

  public twitterHandler: TwitterHandler;

  // Unified command execution wrapper that ensures Twitter connection
  private async executeWithConnection(callback: () => Promise<void>) {
    console.log("[NoteTweet] executeWithConnection called");

    // Check if we have a configured account first
    const currentAccount = this.getCurrentAccount();
    if (!currentAccount) {
      console.log("[NoteTweet] No account configured");
      new TweetErrorModal(this.app, "No Twitter account configured. Please add an account in settings.").open();
      return;
    }

    console.log("[NoteTweet] Account found:", currentAccount.name, "status:", currentAccount.connectionStatus);

    // Skip pre-connection check - let the actual post operation handle connection
    // This prevents hanging on startup when API is slow
    try {
      await callback();
    } catch (e) {
      console.error("[NoteTweet] Command execution error:", e);
      new TweetErrorModal(this.app, `Error: ${e.message}`).open();
    }
  }

  async onload() {
    console.log(WELCOME_MESSAGE);

    await this.loadSettings();
    this.twitterHandler = new TwitterHandler(this);
    // Delay Twitter connection to first use - improves startup performance
    // await this.connectToTwitterWithPlainSettings();

    this.addCommand({
      id: "post-selected-as-tweet",
      name: "Post Selected as Tweet",
      callback: async () => await this.executeWithConnection(() => this.postSelectedTweet()),
    });

    this.addCommand({
      id: "post-file-as-thread",
      name: "Post File as Thread",
      callback: async () => await this.executeWithConnection(() => this.postThreadInFile()),
    });

    this.addCommand({
      id: "post-tweet",
      name: "Post Tweet",
      callback: async () => await this.executeWithConnection(() => this.postTweetMode()),
    });

    /*START.DEVCMD*/
    this.addCommand({
      id: 'reloadNoteTweet',
      name: 'Reload NoteTweet (dev)',
      callback: () => { // @ts-ignore - for this.app.plugins
        const id: string = this.manifest.id, plugins = this.app.plugins;
        plugins.disablePlugin(id).then(() => plugins.enablePlugin(id));
      },
    });
    /*END.DEVCMD*/

    log.register(new ConsoleErrorLogger())
        .register(new GuiLogger(this));

    this.addSettingTab(new NoteTweetSettingsTab(this.app, this));

    // Removed immediate scheduler initialization - now using lazy loading
  }

  private async postTweetMode() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    let editor: Editor;
    let originalSelection: string | null = null;

    if (view instanceof MarkdownView) {
      editor = view.editor;
      
      // Store original selection for tagging later
      if (editor?.somethingSelected()) {
        originalSelection = editor.getSelection();
      }
    }

    let tweet: ITweet | IScheduledTweet;

    if (editor?.somethingSelected()) {
      let text = editor.getSelection();

      try {
        // First try to parse as list format
        const listTweets = this.parseListFromText(text);
        if (listTweets.length > 1) {
          const selection = {text: listTweets.join("--nt_sep--"), thread: true};
          tweet = await NewTweetModal.PostTweet(this.app, selection);
        } else {
          // Single list item, treat as regular text
          throw new Error("Single list item, try other parsing methods");
        }
      } catch {
        try {
          // Then try THREAD START/END format
          text = this.parseThreadFromText(text).join("--nt_sep--");
          const selection = {text, thread: true};
          tweet = await NewTweetModal.PostTweet(this.app, selection);
        } catch {
          // Finally treat as single tweet
          const selection = {text, thread: false};
          tweet = await NewTweetModal.PostTweet(this.app, selection);
        }
      }
    } else {
        tweet = await NewTweetModal.PostTweet(this.app);
    }

    if (tweet instanceof ScheduledTweet) {
      // Get scheduler for the account associated with the tweet
      const scheduler = tweet.accountId ? 
        this.getSchedulerForAccount(tweet.accountId) : 
        this.getCurrentScheduler();
      
      if (!scheduler) {
        new Notice("❌ Scheduling is not enabled for this account");
        return;
      }
      
      await scheduler.scheduleTweet(tweet);
    } else if (tweet instanceof Tweet) {
      try {
        // Ensure the account is connected before posting
        if (tweet.accountId) {
          const connected = await this.twitterHandler.connectToAccountById(tweet.accountId);
          if (!connected) {
            const account = this.getAccountById(tweet.accountId);
            const accountName = account ? account.name : tweet.accountId;
            throw new Error(`Failed to connect to Twitter account: ${accountName}`);
          }
        }
        
        const tweetsPosted: TweetV2PostTweetResult[] = await this.twitterHandler.postThread(tweet.content, tweet.accountId);
        if (tweetsPosted && tweetsPosted.length > 0) {
          
          // Apply tag if there was an original selection
          const account = tweet.accountId ? this.getAccountById(tweet.accountId) : null;
          if (originalSelection && editor && account?.postTweetTag && account.postTweetTag.trim() !== '') {
            const finalContent = this.formatTaggedThread(tweet.content, account.postTweetTag);
            editor.replaceSelection(finalContent);
            new Notice(`Tagged: ${account.postTweetTag}`);
          }
          
          new TweetsPostedModal(this.app, tweetsPosted, this.twitterHandler).open();
        }
      } catch (e) {
        log.logError(`Failed to post tweet: ${e}`);
        new Notice(`Failed to post tweet: ${e.message || e}`);
      }
    }
  }

  public async connectToTwitterWithPlainSettings(skipVerification: boolean = true): Promise<boolean | undefined> {
    // Try to connect to current account in multi-account setup
    const currentAccount = this.getCurrentAccount();
    if (currentAccount) {
      // Skip verification by default to avoid Buffer polyfill issues
      const connected = await this.twitterHandler.connectToAccount(currentAccount, skipVerification);
      if (connected) {
        this.setLastUsedAccount(currentAccount.id);
      }
      return connected;
    }

    // No current account found
    return false;
  }

  private async postThreadInFile() {
    const file = this.app.workspace.getActiveFile();
    let content = await this.getFileContent(file);
    let threadContent: string[];
    try {
      threadContent = this.parseThreadFromText(content);
    } catch (e) {
      log.logError(`error in parsing thread in file ${file?.name}. ${e}`);
      return;
    }

    try {
      // Get current account and ensure it's connected
      const currentAccount = this.getCurrentAccount();
      if (!currentAccount) {
        new Notice("No Twitter account configured. Please add an account in settings.");
        return;
      }
      
      const connected = await this.twitterHandler.connectToAccountById(currentAccount.id);
      if (!connected) {
        new Notice(`Failed to connect to Twitter account: ${currentAccount.name}`);
        return;
      }
      
      let postedTweets = await this.twitterHandler.postThread(threadContent, currentAccount.id);
      if (postedTweets && postedTweets.length > 0) {
        // For threads from files, add tags to each tweet section in the file
        if (currentAccount.postTweetTag && currentAccount.postTweetTag.trim() !== '') {
          await this.tagThreadInFile(file, threadContent, currentAccount.postTweetTag);
          new Notice(`Tagged thread with: ${currentAccount.postTweetTag}`);
        }
        
        // Show the modal after tags have been applied
        let postedModal = new TweetsPostedModal(
          this.app,
          postedTweets,
          this.twitterHandler
        );

        await postedModal.waitForClose;
      }
    } catch (e) {
      log.logError(`failed attempted to post tweets. ${e}`);
      new Notice(`Failed to post thread: ${e.message || e}`);
    }
  }

  private async postSelectedTweet() {
    console.log("[NoteTweet] postSelectedTweet called");
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    let editor;

    if (view instanceof MarkdownView) {
      editor = view.editor;
    } else {
      console.log("[NoteTweet] No MarkdownView active");
      new Notice("Please open a markdown file first");
      return;
    }

    if (editor.somethingSelected()) {
      let selection: string = editor.getSelection();
      console.log("[NoteTweet] Selected text length:", selection.length);

      try {
        // Get current account and ensure it's connected
        const currentAccount = this.getCurrentAccount();
        if (!currentAccount) {
          new Notice("No Twitter account configured. Please add an account in settings.");
          return;
        }

        console.log("[NoteTweet] Connecting to account:", currentAccount.name);
        const connected = await this.twitterHandler.connectToAccountById(currentAccount.id);
        if (!connected) {
          new Notice(`Failed to connect to Twitter account: ${currentAccount.name}`);
          return;
        }

        console.log("[NoteTweet] Posting tweet...");
        // Use postThread for consistency (wrap single tweet in array)
        let tweets = await this.twitterHandler.postThread([selection], currentAccount.id);

        if (tweets && tweets.length > 0) {
          // Prepend tag to selection immediately after posting
          if (currentAccount.postTweetTag && currentAccount.postTweetTag.trim() !== '') {
            const taggedText = `${currentAccount.postTweetTag} :: ${selection}`;
            editor.replaceSelection(taggedText);
            new Notice(`Tagged: ${currentAccount.postTweetTag}`);
          }

          // Show the modal after tag has been applied
          let postedModal = new TweetsPostedModal(
            this.app,
            tweets,
            this.twitterHandler
          );

          await postedModal.waitForClose;
        }
      } catch (e) {
        log.logError(`failed attempt to post selected. ${e}`);
        new Notice(`Failed to post tweet: ${e.message || e}`);
      }
    } else {
      log.logWarning(`tried to post selected but nothing was selected.`);
      new Notice("Please select some text first");
    }
  }


  onunload() {
    console.log(UNLOAD_MESSAGE);
  }

  async loadSettings() {
    const loadedData = await this.loadData() || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedData);
    
    // Migration: Convert legacy single-account to multi-account setup
    await this.migrateLegacySettings();
  }

  private async migrateLegacySettings() {
    const CURRENT_MIGRATION_VERSION = 3; // Increment this when adding new migrations

    // Skip if already migrated to current version
    if (this.settings.migrationVersion === CURRENT_MIGRATION_VERSION) {
      return;
    }

    // Cast to any to access potentially legacy fields
    const rawSettings: any = this.settings;
    let needsSave = false;

    // Migration 1: Legacy single-account to multi-account (version 0 -> 1)
    if (!this.settings.migrationVersion || this.settings.migrationVersion < 1) {
      const hasLegacyCredentials = rawSettings.apiKey &&
                                  rawSettings.apiSecret &&
                                  rawSettings.accessToken &&
                                  rawSettings.accessTokenSecret;

      const hasNoAccounts = !this.settings.accounts || this.settings.accounts.length === 0;

      if (hasLegacyCredentials && hasNoAccounts) {
        console.log("NoteTweet: Migrating from single-account to multi-account setup");

        // Create the first account from legacy credentials with legacy settings
        const legacyAccount = createAccount("My Twitter Account", {
          apiKey: rawSettings.apiKey,
          apiSecret: rawSettings.apiSecret,
          accessToken: rawSettings.accessToken,
          accessTokenSecret: rawSettings.accessTokenSecret
        }, {
          postTweetTag: rawSettings.postTweetTag || "",
          autoSplitTweets: rawSettings.autoSplitTweets ?? true,
          // Migrate global scheduling to first account
          scheduling: rawSettings.scheduling || {
            enabled: false,
            url: "",
            password: "",
            cronStrings: []
          }
        });

        // Set up the new multi-account structure
        this.settings.accounts = [legacyAccount];
        this.settings.lastUsedAccountId = legacyAccount.id;

        // Clean up legacy fields from settings
        this.cleanupLegacyFields();

        needsSave = true;
        new Notice("NoteTweet: Successfully migrated to multi-account support! Your account is now named 'My Twitter Account'.");
      }
    }

    // Migration 2: Global scheduling to account-level (version 1 -> 2)
    if (!this.settings.migrationVersion || this.settings.migrationVersion < 2) {
      if (rawSettings.scheduling && this.settings.accounts.length > 0) {
        console.log("NoteTweet: Migrating global scheduling to all accounts");

        let migratedCount = 0;

        // Migrate scheduling settings to ALL accounts that don't have it yet
        for (const account of this.settings.accounts) {
          if (!account.scheduling) {
            account.scheduling = {
              enabled: rawSettings.scheduling.enabled || false,
              url: rawSettings.scheduling.url || "",
              password: rawSettings.scheduling.password || "",
              cronStrings: rawSettings.scheduling.cronStrings || []
            };
            migratedCount++;
          }
        }

        if (migratedCount > 0) {
          delete rawSettings.scheduling;
          needsSave = true;
          new Notice(`NoteTweet: Scheduling settings migrated to ${migratedCount} account(s)`);
        }
      }
    }

    // Migration 3: Clean up deprecated fields (version 2 -> 3)
    if (!this.settings.migrationVersion || this.settings.migrationVersion < 3) {
      for (const account of this.settings.accounts) {
        // Clean up secureMode field
        if ((account as any).secureMode !== undefined) {
          delete (account as any).secureMode;
          needsSave = true;
        }

        // Clean up isActive field
        if ((account as any).isActive !== undefined) {
          delete (account as any).isActive;
          needsSave = true;
        }
      }

      if (needsSave) {
        console.log("NoteTweet: Cleaned up deprecated fields from accounts");
      }
    }

    // Update migration version and save if needed
    if (this.settings.migrationVersion !== CURRENT_MIGRATION_VERSION) {
      this.settings.migrationVersion = CURRENT_MIGRATION_VERSION;
      needsSave = true;
    }

    // Save all changes at once
    if (needsSave) {
      await this.saveSettings();
    }
  }

  private cleanupLegacyFields() {
    // Remove legacy fields from settings object to keep data.json clean
    const rawSettings: any = this.settings;
    delete rawSettings.apiKey;
    delete rawSettings.apiSecret;
    delete rawSettings.accessToken;
    delete rawSettings.accessTokenSecret;
    delete rawSettings.postTweetTag;
    delete rawSettings.autoSplitTweets;
    delete rawSettings.scheduling; // Remove global scheduling
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }


  // Lazy initialization of schedulers - only create when needed
  private getOrCreateScheduler(account: TwitterAccount): NoteTweetScheduler | null {
    if (!account.scheduling || !account.scheduling.enabled) {
      return null;
    }

    // Check if scheduler already exists
    let scheduler = this.schedulers.get(account.id);
    if (!scheduler) {
      // Create scheduler on demand
      scheduler = new SelfHostedScheduler(
        this.app,
        account.scheduling.url,
        account.scheduling.password
      );
      this.schedulers.set(account.id, scheduler);
      console.log(`NoteTweet: Created scheduler for account "${account.name}" on demand`);
    }

    return scheduler;
  }
  
  // Get scheduler for a specific account (lazy initialization)
  public getSchedulerForAccount(accountId: string): NoteTweetScheduler | null {
    const account = this.getAccountById(accountId);
    if (!account) return null;
    return this.getOrCreateScheduler(account);
  }
  
  // Get scheduler for current account (lazy initialization)
  public getCurrentScheduler(): NoteTweetScheduler | null {
    const currentAccount = this.getCurrentAccount();
    if (!currentAccount) return null;
    return this.getOrCreateScheduler(currentAccount);
  }

  // Account management helper methods
  public getCurrentAccount(): TwitterAccount | null {
    if (!this.settings.accounts || this.settings.accounts.length === 0) {
      return null;
    }
    
    // Try to get the last used account first
    if (this.settings.lastUsedAccountId) {
      const lastUsedAccount = this.settings.accounts.find(
        account => account.id === this.settings.lastUsedAccountId
      );
      if (lastUsedAccount) {
        return lastUsedAccount;
      }
    }
    
    // Fall back to first available account
    return this.settings.accounts[0] || null;
  }
  
  public getAccountById(accountId: string): TwitterAccount | null {
    if (!this.settings.accounts) return null;
    return this.settings.accounts.find(account => account.id === accountId) || null;
  }
  
  public setLastUsedAccount(accountId: string): void {
    if (this.getAccountById(accountId)) {
      this.settings.lastUsedAccountId = accountId;
      this.saveSettings();
    }
  }
  
  public addAccount(account: TwitterAccount): void {
    if (!this.settings.accounts) {
      this.settings.accounts = [];
    }
    
    this.settings.accounts.push(account);
    
    // Set as last used if it's the first account
    if (this.settings.accounts.length === 1) {
      this.settings.lastUsedAccountId = account.id;
    }
    
    this.saveSettings();
  }
  
  public removeAccount(accountId: string): boolean {
    if (!this.settings.accounts) return false;
    
    const accountIndex = this.settings.accounts.findIndex(account => account.id === accountId);
    if (accountIndex === -1) return false;
    
    this.settings.accounts.splice(accountIndex, 1);
    
    // Update last used if it referenced the removed account
    if (this.settings.lastUsedAccountId === accountId) {
      this.settings.lastUsedAccountId = this.settings.accounts.length > 0 ? this.settings.accounts[0].id : "";
    }
    
    this.saveSettings();
    return true;
  }

  async getFileContent(file: TFile): Promise<string> {
    if (file.extension != "md") return null;

    return await this.app.vault.read(file);
  }

  // All threads start with THREAD START and ends with THREAD END. To separate tweets in a thread,
  // one should use use a newline and '---' (this prevents markdown from believing the above tweet is a heading).
  // We also purposefully remove the newline after the separator - otherwise tweets will be posted with a newline
  // as their first line.
  private parseThreadFromText(text: string) {
    let contentArray = text.split("\n");
    let threadStartIndex = contentArray.indexOf("THREAD START") + 1;
    let threadEndIndex = contentArray.indexOf("THREAD END");

    if (threadStartIndex == 0 || threadEndIndex == -1) {
      throw new Error("Failed to detect THREAD START or THREAD END");
    }

    let content = contentArray
      .slice(threadStartIndex, threadEndIndex)
      .join("\n")
      .split("\n---\n");
    if (content.length == 1 && content[0] == "") {
      throw new Error("Please write something in your thread.");
    }

    return content.map((txt) => txt.trim());
  }

  private async tagThreadInFile(file: TFile, threadContent: string[], tagText: string) {
    let fileContent = await this.getFileContent(file);
    
    // Tag each tweet section in the thread
    for (const tweetText of threadContent) {
      const trimmedTweet = tweetText.trim();
      if (trimmedTweet && fileContent.includes(trimmedTweet)) {
        const taggedText = `${tagText} :: ${trimmedTweet}`;
        fileContent = fileContent.replace(trimmedTweet, taggedText);
      }
    }
    
    await this.app.vault.modify(file, fileContent);
  }

  private parseListFromText(text: string): string[] {
    const lines = text.split('\n');
    const tweets: string[] = [];
    
    for (const line of lines) {
      const trimmedLine = line.trim();
      if (trimmedLine.startsWith('- ')) {
        // Extract list item content (remove "- " prefix)
        tweets.push(trimmedLine.substring(2).trim());
      }
    }
    
    if (tweets.length === 0) {
      throw new Error("No list items found");
    }
    
    return tweets;
  }

  private formatTaggedThread(tweetContent: string[], tagText: string): string {
    if (tweetContent.length === 0) return '';
    
    // Assume the first tweet already has "- " prefix from selection, so don't add extra "- "
    const taggedFirstTweet = `${tagText} :: ${tweetContent[0]}`;
    
    // Subsequent tweets remain as sub-items with 4-space indentation
    const subsequentTweets = tweetContent.slice(1).map(tweet => 
      `    - ${tweet}`
    );
    
    return [taggedFirstTweet, ...subsequentTweets].join('\n');
  }

}
