import { App, Modal } from "obsidian";
import NoteTweet from "../../main";
import { SecureModeCrypt } from "../../SecureModeCrypt";
import SecureModeSettingModalContent from "./SecureModeSettingModalContent.svelte";
import set = Reflect.set;

export class SecureModeModal extends Modal {
  private plugin: NoteTweet;
  private readonly enable: boolean;
  private resolvePromise: () => void;
  private secureModeSettingModalContent: SecureModeSettingModalContent;
  public waitForResolve: Promise<void>;
  public userPressedCrypt: boolean = false;

  constructor(app: App, plugin: NoteTweet, enable: boolean) {
    super(app);
    this.plugin = plugin;
    this.enable = enable;

    this.waitForResolve = new Promise<void>(
      (resolve) => (this.resolvePromise = resolve)
    );

    this.secureModeSettingModalContent = new SecureModeSettingModalContent({
      target: this.contentEl,
      props: {
        enable: this.enable,
        userPressedCrypt: this.userPressedCrypt,
        onSubmit: (value: string) => this.onSubmit(value),
      },
    });

    this.open();
  }

  private async onSubmit(value: string) {
    this.enable
      ? await this.encryptKeysWithPassword(value)
      : await this.decryptKeysWithPassword(value);

    this.userPressedCrypt = true;

    this.close();
  }

  onClose() {
    super.onClose();
    this.secureModeSettingModalContent.$destroy();
    this.resolvePromise();
  }

  private async encryptKeysWithPassword(password: string) {
    // TODO: Update to work with multi-account system
    const currentAccount = this.plugin.getCurrentAccount();
    if (!currentAccount) {
      return;
    }

    currentAccount.apiKey = SecureModeCrypt.encryptString(
      currentAccount.apiKey,
      password
    );
    currentAccount.apiSecret = SecureModeCrypt.encryptString(
      currentAccount.apiSecret,
      password
    );
    currentAccount.accessToken = SecureModeCrypt.encryptString(
      currentAccount.accessToken,
      password
    );
    currentAccount.accessTokenSecret = SecureModeCrypt.encryptString(
      currentAccount.accessTokenSecret,
      password
    );

    await this.plugin.saveSettings();
  }

  private async decryptKeysWithPassword(password: string) {
    // TODO: Update to work with multi-account system
    const currentAccount = this.plugin.getCurrentAccount();
    if (!currentAccount) {
      return;
    }

    currentAccount.apiKey = SecureModeCrypt.decryptString(
      currentAccount.apiKey,
      password
    );
    currentAccount.apiSecret = SecureModeCrypt.decryptString(
      currentAccount.apiSecret,
      password
    );
    currentAccount.accessToken = SecureModeCrypt.decryptString(
      currentAccount.accessToken,
      password
    );
    currentAccount.accessTokenSecret = SecureModeCrypt.decryptString(
      currentAccount.accessTokenSecret,
      password
    );

    await this.plugin.saveSettings();
  }
}
