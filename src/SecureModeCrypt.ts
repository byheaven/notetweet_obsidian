// Stub file - SecureMode is not used in multi-account version
// This file exists only to satisfy imports from legacy SecureMode modals

export class SecureModeCrypt {
  static encryptString(text: string, password: string): string {
    console.warn("SecureModeCrypt.encryptString called but SecureMode is not supported in multi-account version");
    return text;
  }

  static decryptString(text: string, password: string): string {
    console.warn("SecureModeCrypt.decryptString called but SecureMode is not supported in multi-account version");
    return text;
  }
}
