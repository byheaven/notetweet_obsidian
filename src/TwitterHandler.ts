import { SendTweetV2Params, TweetV2, TwitterApi } from "twitter-api-v2";
import { getMimeType } from "twitter-api-v2/dist/esm/v1/media-helpers.v1";
import NoteTweet from "./main";
import { log } from "./ErrorModule/logManager";
import { TwitterAccount } from "./settings";

interface AccountConnection {
  accountId: string;
  client: TwitterApi;
  isConnected: boolean;
}

export class TwitterHandler {
  private connections: Map<string, AccountConnection> = new Map();
  private currentAccountId: string | null = null;

  constructor(private plugin: NoteTweet) {}

  // Legacy property for backward compatibility
  public get isConnectedToTwitter(): boolean {
    const currentAccount = this.getCurrentConnection();
    return currentAccount ? currentAccount.isConnected : false;
  }

  private getCurrentConnection(): AccountConnection | null {
    if (!this.currentAccountId) {
      return null;
    }
    return this.connections.get(this.currentAccountId) || null;
  }

  // Legacy method for backward compatibility
  public async connectToTwitter(
    apiKey: string,
    apiSecret: string,
    accessToken: string,
    accessTokenSecret: string
  ): Promise<boolean> {
    // Use the current account or create a temporary connection for legacy support
    const currentAccount = this.plugin.getCurrentAccount();
    if (currentAccount) {
      return await this.connectToAccount(currentAccount);
    }
    
    // Fallback for legacy usage - create temporary connection
    try {
      const tempClient = new TwitterApi({
        appKey: apiKey,
        appSecret: apiSecret,
        accessToken: accessToken,
        accessSecret: accessTokenSecret,
      });
      
      await tempClient.v2.me();
      return true;
    } catch (e) {
      console.error("Twitter authentication verification failed:", e);
      return false;
    }
  }

  public async connectToAccount(account: TwitterAccount): Promise<boolean> {
    try {
      const client = new TwitterApi({
        appKey: account.apiKey,
        appSecret: account.apiSecret,
        accessToken: account.accessToken,
        accessSecret: account.accessTokenSecret,
      });
      
      // Verify credentials by making a test API call
      try {
        await client.v2.me();
        
        const connection: AccountConnection = {
          accountId: account.id,
          client: client,
          isConnected: true
        };
        
        this.connections.set(account.id, connection);
        this.currentAccountId = account.id;
        
        // Update account connection status
        account.connectionStatus = 'connected';
        account.lastConnectionTest = Date.now();
        account.lastError = undefined;
        await this.plugin.saveSettings();
        
        return true;
      } catch (e) {
        console.error(`Twitter authentication verification failed for account ${account.name}:`, e);
        
        const connection: AccountConnection = {
          accountId: account.id,
          client: client,
          isConnected: false
        };
        this.connections.set(account.id, connection);
        
        // Update account connection status with error
        account.connectionStatus = 'failed';
        account.lastConnectionTest = Date.now();
        account.lastError = this.extractErrorMessage(e);
        await this.plugin.saveSettings();
        
        return false;
      }
    } catch (e) {
      console.error(`Failed to create Twitter client for account ${account.name}:`, e);
      
      // Update account connection status with error
      account.connectionStatus = 'failed';
      account.lastConnectionTest = Date.now();
      account.lastError = this.extractErrorMessage(e);
      await this.plugin.saveSettings();
      
      return false;
    }
  }
  
  private extractErrorMessage(error: any): string {
    if (error?.message) {
      return error.message;
    }
    if (error?.data?.detail) {
      return error.data.detail;
    }
    if (error?.data?.error) {
      return error.data.error;
    }
    if (typeof error === 'string') {
      return error;
    }
    return 'Unknown error occurred';
  }

  public async connectToAccountById(accountId: string): Promise<boolean> {
    const account = this.plugin.getAccountById(accountId);
    if (!account) {
      return false;
    }
    
    return await this.connectToAccount(account);
  }

  public switchToAccount(accountId: string): boolean {
    if (this.connections.has(accountId)) {
      this.currentAccountId = accountId;
      return true;
    }
    return false;
  }

  public getAccountConnection(accountId: string): AccountConnection | null {
    return this.connections.get(accountId) || null;
  }

  public isAccountConnected(accountId: string): boolean {
    const connection = this.connections.get(accountId);
    return connection ? connection.isConnected : false;
  }

  public getCurrentAccountId(): string | null {
    return this.currentAccountId;
  }

  public async postThread(threadContent: string[], accountId?: string) {
    const connection = accountId ? 
      this.getAccountConnection(accountId) : 
      this.getCurrentConnection();
    
    if (!connection || !connection.isConnected) {
      // Try to reconnect if account exists
      const account = accountId ? 
        this.plugin.getAccountById(accountId) : 
        this.plugin.getCurrentAccount();
      
      if (account) {
        console.log(`Connection lost for ${account.name}, attempting to reconnect...`);
        const reconnected = await this.connectToAccount(account);
        
        if (!reconnected) {
          const errorMsg = account.lastError || "Unable to connect to Twitter";
          throw new Error(`Failed to reconnect account "${account.name}": ${errorMsg}`);
        }
        
        // Get connection again after reconnect
        const newConnection = accountId ? 
          this.getAccountConnection(accountId) : 
          this.getCurrentConnection();
        
        if (newConnection && newConnection.isConnected) {
          let tweets = [];
          for (const threadTweet of threadContent) {
            const tweet: SendTweetV2Params = await this.constructTweet(threadTweet, newConnection);
            tweets.push(tweet);
          }
          return await newConnection.client.v2.tweetThread(tweets);
        }
      }
      
      throw new Error(accountId ? 
        `Account not connected: ${accountId}` : 
        "No account connected for posting thread");
    }

    let tweets = [];

    for (const threadTweet of threadContent) {
      const tweet: SendTweetV2Params = await this.constructTweet(threadTweet, connection);
      tweets.push(tweet);
    }
    try {
      return await connection.client.v2.tweetThread(tweets);
    } catch (e) {
      // Update account connection status on failure
      const account = accountId ? 
        this.plugin.getAccountById(accountId) : 
        this.plugin.getCurrentAccount();
      
      if (account) {
        account.connectionStatus = 'failed';
        account.lastConnectionTest = Date.now();
        account.lastError = this.extractErrorMessage(e);
        await this.plugin.saveSettings();
      }
      
      console.log(`error in posting tweet thread: ${e}`);
      throw e;
    }
  }

  IMAGE_REGEX: RegExp = new RegExp(
    /!?\[\[([a-zA-Z 0-9-\.]*\.(gif|jpe?g|tiff?|png|webp|bmp))\]\]/
  );
  public async postTweet(tweetText: string, accountId?: string) {
    const connection = accountId ? 
      this.getAccountConnection(accountId) : 
      this.getCurrentConnection();
    
    if (!connection || !connection.isConnected) {
      // Try to reconnect if account exists
      const account = accountId ? 
        this.plugin.getAccountById(accountId) : 
        this.plugin.getCurrentAccount();
      
      if (account) {
        console.log(`Connection lost for ${account.name}, attempting to reconnect...`);
        const reconnected = await this.connectToAccount(account);
        
        if (!reconnected) {
          const errorMsg = account.lastError || "Unable to connect to Twitter";
          throw new Error(`Failed to reconnect account "${account.name}": ${errorMsg}`);
        }
        
        // Get connection again after reconnect
        const newConnection = accountId ? 
          this.getAccountConnection(accountId) : 
          this.getCurrentConnection();
        
        if (newConnection && newConnection.isConnected) {
          const tweet: SendTweetV2Params = await this.constructTweet(tweetText, newConnection);
          return await newConnection.client.v2.tweet(tweet);
        }
      }
      
      throw new Error(accountId ? 
        `Account not connected: ${accountId}` : 
        "No account connected for posting tweet");
    }

    const tweet: SendTweetV2Params = await this.constructTweet(tweetText, connection);

    try {
      return await connection.client.v2.tweet(tweet);
    } catch (e) {
      // Update account connection status on failure
      const account = accountId ? 
        this.plugin.getAccountById(accountId) : 
        this.plugin.getCurrentAccount();
      
      if (account) {
        account.connectionStatus = 'failed';
        account.lastConnectionTest = Date.now();
        account.lastError = this.extractErrorMessage(e);
        await this.plugin.saveSettings();
      }
      
      console.log(`error in posting tweet. ${e}`);
      throw e;
    }
  }

  private async constructTweet(tweet: string, connection: AccountConnection): Promise<SendTweetV2Params> {
    let media_ids: string[] = [];
    let processedTweet = tweet;

    while (this.IMAGE_REGEX.test(processedTweet)) {
      const match = this.IMAGE_REGEX.exec(processedTweet);
      const fileName: string = match[1];

      // TODO: correctly handle the source path
      const file = this.plugin.app.metadataCache.getFirstLinkpathDest(fileName, "");
      const mimeType = getMimeType(fileName);
      const data = Buffer.from(await file.vault.readBinary(file));
      const media_id = await connection.client.v1.uploadMedia(data, { mimeType });

      if (media_id) {
        media_ids.push(media_id);
        processedTweet = processedTweet.replace(this.IMAGE_REGEX, "");
      } else {
        log.logWarning(
          `image '${fileName}' found but could not upload it to Twitter. Data is null/undefined: ${!!media_ids}.`
        );
      }
    }

    return {
      text: processedTweet,
      ...(media_ids.length > 0 ? { media: { media_ids: media_ids as any } } : {}),
    };
  }

  public async deleteTweets(tweets: TweetV2[], accountId?: string) {
    const connection = accountId ? 
      this.getAccountConnection(accountId) : 
      this.getCurrentConnection();
    
    if (!connection || !connection.isConnected) {
      throw new Error(accountId ? 
        `Account not connected: ${accountId}` : 
        "No account connected for deleting tweets");
    }

    try {
      for (const tweet of tweets)
        await connection.client.v2.deleteTweet(tweet.id);

      return true;
    } catch (e) {
      log.logError(`error in deleting tweets. ${e}`);
      return false;
    }
  }
}
