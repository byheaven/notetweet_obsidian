import { App, Modal, Notice } from "obsidian";
import NoteTweet from "../../main";
import { SecureModeCrypt } from "../../SecureModeCrypt";
import SecureModeGetPasswordModalContent from "./SecureModeGetPasswordModalContent.svelte";

export class SecureModeGetPasswordModal extends Modal {
  private modalContent: SecureModeGetPasswordModalContent;
  private resolvePromise: () => void;
  public waitForClose: Promise<void>;

  private _plugin: NoteTweet;

  constructor(app: App, plugin: NoteTweet) {
    super(app);
    this._plugin = plugin;

    this.waitForClose = new Promise<void>(
      (resolve) => (this.resolvePromise = resolve)
    );

    this.modalContent = new SecureModeGetPasswordModalContent({
      target: this.contentEl,
      props: {
        onSubmit: (value: string) => this.onSubmit(value),
      },
    });

    this.open();
  }

  onClose() {
    super.onClose();
    this.modalContent.$destroy();
    this.resolvePromise();
  }

  private async onSubmit(value: string) {
    if (value === "") return;

    try {
      const connected = await this.secureModeLogin(value);
      if (connected) {
        new Notice("Successfully authenticated with Twitter!");
        this.close();
      } else {
        new Notice(
          "Failed to authenticate with Twitter. Please check your credentials."
        );
      }
    } catch (e) {
      new Notice("Wrong password or decryption failed.");
    }
  }

  private async secureModeLogin(password: string): Promise<boolean> {
    // TODO: Update to work with multi-account system
    const currentAccount = this._plugin.getCurrentAccount();
    if (!currentAccount) {
      return false;
    }

    return await this._plugin.twitterHandler.connectToTwitter(
      SecureModeCrypt.decryptString(currentAccount.apiKey, password),
      SecureModeCrypt.decryptString(currentAccount.apiSecret, password),
      SecureModeCrypt.decryptString(currentAccount.accessToken, password),
      SecureModeCrypt.decryptString(currentAccount.accessTokenSecret, password)
    );
  }
}
