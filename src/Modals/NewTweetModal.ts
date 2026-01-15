import {IScheduledTweet} from "../Types/IScheduledTweet";
import {ITweet} from "../Types/ITweet";
import {App} from "obsidian";
import {log} from "../ErrorModule/logManager";
import {Tweet} from "../Types/Tweet";
import {promptForDateTime} from "../utility";
import {ScheduledTweet} from "../Types/ScheduledTweet";
import {PostTweetModal} from "./PostTweetModal";
import NoteTweet from "../main";

export class NewTweetModal extends PostTweetModal<IScheduledTweet | ITweet> {
    private selectedAccountId: string | null = null;

    static PostTweet(app: App, selection?: { text: string, thread: boolean }): Promise<ITweet | IScheduledTweet> {
        // Get plugin instance
        const plugin = (app as any).plugins.plugins["notetweet"] as NoteTweet;
        const modal = new NewTweetModal(app, plugin, selection);
        modal.open();
        return modal.newTweet;
    }

    constructor(app: App, plugin: NoteTweet, selection?: { text: string, thread: boolean }) {
        super(app, plugin, selection);
        // Default to current account
        this.selectedAccountId = plugin.getCurrentAccount()?.id || null;
    }

    protected createFirstTextarea() {
        // Add account selector before the first textarea
        this.addAccountSelector(this.textZone);
        super.createFirstTextarea();
    }

    private addAccountSelector(container: HTMLElement) {
        const accounts = this.plugin.settings.accounts || [];
        if (accounts.length <= 1) return; // No need for selector with 0-1 accounts

        const selectorDiv = container.createDiv({ cls: "notetweet-account-selector" });
        selectorDiv.style.marginBottom = "10px";
        selectorDiv.style.padding = "8px";
        selectorDiv.style.borderBottom = "1px solid var(--background-modifier-border)";

        const label = selectorDiv.createEl("span", { text: "Post as: " });
        label.style.marginRight = "8px";

        const select = selectorDiv.createEl("select");
        select.style.padding = "4px 8px";

        for (const account of accounts) {
            const option = select.createEl("option", {
                text: account.name,
                value: account.id
            });
            if (account.id === this.selectedAccountId) {
                option.selected = true;
            }
        }

        select.addEventListener("change", () => {
            this.selectedAccountId = select.value;
        });
    }

    protected addActionButtons() {
        this.createTweetButton(this.contentEl);
        this.createScheduleButton(this.contentEl);
    }

    private createTweetButton(contentEl: HTMLElement) {
        let postButton = contentEl.createEl("button", {text: "Post!"});
        postButton.addClass("postTweetButton");

        postButton.addEventListener("click", this.postTweets());
    }

    private createScheduleButton(contentEl: HTMLElement) {
        const scheduleButton = contentEl.createEl('button', {text: 'Schedule'});
        scheduleButton.addClass("postTweetButton");

        scheduleButton.addEventListener('click', this.scheduleTweets());
    }

    private postTweets() {
        return async () => {
            const threadContent: string[] = this.getThreadContent();
            if (!threadContent) return;

            const tweet: ITweet = new Tweet(threadContent, this.selectedAccountId || undefined);
            this.resolve(tweet);
            this.close();
        };
    }

    scheduleTweets() {
        return async () => {
            const threadContent: string[] = this.getThreadContent();
            if (!threadContent) return;

            const scheduledDateTime: number = await promptForDateTime(this.app);
            const tweet: IScheduledTweet = new ScheduledTweet(threadContent, scheduledDateTime, this.selectedAccountId || undefined);
            this.resolve(tweet);
            this.close();
        }
    }
}