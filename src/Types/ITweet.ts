export interface ITweet {
  id: string;
  content: string[];
  accountId?: string; // Optional for backward compatibility
}
