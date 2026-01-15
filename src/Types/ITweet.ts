export interface ITweet {
    id: string;
    content: string[];
    accountId?: string; // For multi-account support
}

