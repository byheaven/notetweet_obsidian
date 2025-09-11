import {Editor, MarkdownView, Notice, Plugin, TFile} from "obsidian";
import {TwitterHandler} from "./TwitterHandler";
import {DEFAULT_SETTINGS, NoteTweetSettings, NoteTweetSettingsTab, createAccount, TwitterAccount} from "./settings";
import {TweetsPostedModal} from "./Modals/TweetsPostedModal/TweetsPostedModal";
import {TweetErrorModal} from "./Modals/TweetErrorModal";
import {SecureModeGetPasswordModal} from "./Modals/SecureModeGetPasswordModal/SecureModeGetPasswordModal";
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

  async onload() {
    console.log(WELCOME_MESSAGE);

    await this.loadSettings();
    this.twitterHandler = new TwitterHandler(this);
    await this.connectToTwitterWithPlainSettings();

    this.addCommand({
      id: "post-selected-as-tweet",
      name: "Post Selected as Tweet",
      callback: async () => {
        if (this.twitterHandler.isConnectedToTwitter)
          await this.postSelectedTweet();
        else if (this.getCurrentAccountSecureMode())
          await this.secureModeProxy(
            async () => await this.postSelectedTweet()
          );
        else {
          this.connectToTwitterWithPlainSettings();

          if (!this.twitterHandler.isConnectedToTwitter)
            new TweetErrorModal(this.app, "Not connected to Twitter").open();
          else await this.postSelectedTweet();
        }
      },
    });

    this.addCommand({
      id: "post-file-as-thread",
      name: "Post File as Thread",
      callback: async () => {
        if (this.twitterHandler.isConnectedToTwitter)
          await this.postThreadInFile();
        else if (this.getCurrentAccountSecureMode())
          await this.secureModeProxy(async () => await this.postThreadInFile());
        else {
          this.connectToTwitterWithPlainSettings();

          if (!this.twitterHandler.isConnectedToTwitter)
            new TweetErrorModal(this.app, "Not connected to Twitter").open();
          else await this.postThreadInFile();
        }
      },
    });

    this.addCommand({
      id: "post-tweet",
      name: "Post Tweet",
      callback: async () => {
        if (this.twitterHandler.isConnectedToTwitter) await this.postTweetMode();
        else if (this.getCurrentAccountSecureMode())
          await this.secureModeProxy(async () => await this.postTweetMode());
        else {
          this.connectToTwitterWithPlainSettings();

          if (!this.twitterHandler.isConnectedToTwitter)
            new TweetErrorModal(this.app, "Not connected to Twitter").open();
          else await this.postTweetMode();
        }
      },
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

    // Initialize schedulers for accounts with scheduling enabled
    this.initializeSchedulers();
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

  public async connectToTwitterWithPlainSettings(): Promise<boolean | undefined> {
    if (this.getCurrentAccountSecureMode()) {
      return undefined;
    }
    
    // Try to connect to current account in multi-account setup
    const currentAccount = this.getCurrentAccount();
    if (currentAccount) {
      const connected = await this.twitterHandler.connectToAccount(currentAccount);
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
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    let editor;

    if (view instanceof MarkdownView) {
      editor = view.editor;
    } else {
      return;
    }

    if (editor.somethingSelected()) {
      let selection: string = editor.getSelection();

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
        
        let tweet = await this.twitterHandler.postTweet(selection, currentAccount.id);
        
        if (tweet) {
          // Prepend tag to selection immediately after posting
          if (currentAccount.postTweetTag && currentAccount.postTweetTag.trim() !== '') {
            // For single tweet, don't add extra "- " as the selection already contains it
            const taggedText = `${currentAccount.postTweetTag} :: ${selection}`;
            editor.replaceSelection(taggedText);
            new Notice(`Tagged: ${currentAccount.postTweetTag}`);
          }
          
          // Show the modal after tag has been applied
          let postedModal = new TweetsPostedModal(
            this.app,
            [tweet],
            this.twitterHandler
          );

          await postedModal.waitForClose;
        }
      } catch (e) {
        log.logError(`failed attempt to post selected. ${e}`);
        new Notice(`Failed to post tweet: ${e.message || e}`);
      }
    } else {
      log.logWarning(`tried to post selected but nothing was selected.`)
    }
  }

  private async secureModeProxy(callback: any) {
    if (
      !(this.getCurrentAccountSecureMode() && !this.twitterHandler.isConnectedToTwitter)
    )
      return;

    let modal = new SecureModeGetPasswordModal(this.app, this);

    modal.waitForClose
      .then(async () => {
        if (this.twitterHandler.isConnectedToTwitter) await callback();
        else log.logWarning("could not connect to Twitter");
      })
      .catch(() => {
        modal.close();
        log.logWarning("could not connect to Twitter.");
      });
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
    // Cast to any to access potentially legacy fields
    const rawSettings: any = this.settings;
    
    // Check if we have legacy single-account settings but no accounts array
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
        secureMode: rawSettings.secureMode || false,
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
      
      await this.saveSettings();
      
      new Notice("NoteTweet: Successfully migrated to multi-account support! Your account is now named 'My Twitter Account'.");
    }
    
    // Migrate global scheduling to account-level if needed
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
        await this.saveSettings();
        
        new Notice(`NoteTweet: Scheduling settings migrated to ${migratedCount} account(s)`);
      }
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
    delete rawSettings.secureMode;
    delete rawSettings.scheduling; // Remove global scheduling
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // Helper method to get current account's secure mode setting
  private getCurrentAccountSecureMode(): boolean {
    const currentAccount = this.getCurrentAccount();
    return currentAccount ? currentAccount.secureMode : false;
  }
  
  // Initialize schedulers for accounts with scheduling enabled
  private initializeSchedulers() {
    this.schedulers.clear();
    
    for (const account of this.settings.accounts) {
      if (account.scheduling && account.scheduling.enabled) {
        const scheduler = new SelfHostedScheduler(
          this.app,
          account.scheduling.url,
          account.scheduling.password
        );
        this.schedulers.set(account.id, scheduler);
        console.log(`NoteTweet: Initialized scheduler for account "${account.name}"`);
      }
    }
  }
  
  // Get scheduler for a specific account
  public getSchedulerForAccount(accountId: string): NoteTweetScheduler | null {
    return this.schedulers.get(accountId) || null;
  }
  
  // Get scheduler for current account
  public getCurrentScheduler(): NoteTweetScheduler | null {
    const currentAccount = this.getCurrentAccount();
    if (!currentAccount) return null;
    return this.getSchedulerForAccount(currentAccount.id);
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
