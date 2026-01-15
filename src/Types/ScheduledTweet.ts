import {Tweet} from "./Tweet";
import {IScheduledTweet} from "./IScheduledTweet";

export class ScheduledTweet extends Tweet implements IScheduledTweet {
    postat: number;

    constructor(tweets: string[], postat: number, accountId?: string) {
        super(tweets, accountId);
        this.postat = postat;
    }
}