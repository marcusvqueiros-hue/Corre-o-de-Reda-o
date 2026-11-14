export * from "./errors";
export * from "./params";
export * from "./schema";
export { createVault, unlockVault, unlockVaultWithRecoveryKey, changeMasterPassword, resetMasterPasswordWithRecoveryKey, rotateRecoveryKey, type UnlockedVault } from "./vault";
export { encryptRecord, decryptRecord, type RecordContext } from "./record";
