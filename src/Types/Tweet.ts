import {v4 as uuidv4} from "uuid";
import {ITweet} from "./ITweet";

export class Tweet implements ITweet {
    id: string;
    content: string[];
    accountId?: string;

    constructor(tweet: string[], accountId?: string) {
        this.content = tweet;
        this.id = uuidv4();
        this.accountId = accountId;
    }
}