import { t as translate, awaitNativeLocalization } from "./i18n";
import { invoke, isTauri } from "@tauri-apps/api/core";
import type {
  DesktopSnapshot,
  BackupPreview, ManualTokenInput, TokenParameters, TokenCode, TrashEntry, SyncConnectionInfo,
  SyncStatus,
  SyncConnection,
  SyncCredentials,
  VaultStatus,
  BackupStatus, ExternalBackupStatus,
  QuickCapabilities,
  TokenView,
  ImportPreview,
  QrImportProgress,
  LoginResult,
  Confirmation,
  MarketResult,
  Enrollment,
  NetworkSettings,
  NetworkReport,
} from "./types";

export const native = isTauri();
export const call = <T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> => {
  if (!native)
    return Promise.reject(
      new Error(translate("请通过 Tauri 应用使用此功能。浏览器仅用于界面预览。")),
    );
  const ready = ["quick_configure", "quick_biometric_unlock"].includes(command) ? awaitNativeLocalization() : Promise.resolve();
  return ready.then(() => invoke<T>(command, args)).then(result => {
    if (["token_create", "token_update", "token_rename", "token_delete", "token_batch", "token_reorder", "token_group_manage", "token_advance", "import_commit", "backup_restore_selected", "trash_restore"].includes(command)) window.dispatchEvent(new Event("steamguard:local-change"));
    return result;
  });
};
export const api = {
  desktopSettings: () =>
    call<{ supported: boolean; resident: boolean }>("desktop_settings"),
  desktopConfigure: (resident: boolean) =>
    call<{ supported: boolean; resident: boolean }>("desktop_configure", {
      resident,
    }),
  desktopSnapshot: () => call<DesktopSnapshot>("desktop_snapshot"),
  desktopCodes: () => call<{ revision: string; codes: TokenCode[] }>("desktop_codes"),
  desktopCopy: (id: string) => call<void>("desktop_copy", { id }),
  desktopOpen: () => call<void>("desktop_open_main"),
  desktopHide: () => call<void>("desktop_hide"),
  syncSetAlias: (alias: string) => call<SyncStatus>("sync_set_alias", { alias }),
  syncUpdateCredentials: (connection: SyncCredentials) => call<SyncStatus>("sync_update_credentials", { connection }),
  syncConnectionInfo: () => call<SyncConnectionInfo>("sync_connection_info"),
  syncStatus: () => call<SyncStatus>("sync_status"),
  syncConnect: (args: SyncConnection) =>
    call<SyncStatus>("sync_connect", { connection: args }),
  syncDiscover: (connection?: SyncCredentials) =>
    call<string[]>("sync_discover", { connection }),
  syncSwitch: (libraryId: string, syncPassword: string) =>
    call<SyncStatus>("sync_switch", { libraryId, syncPassword }),
  syncRun: (automatic = false) => call<SyncStatus>("sync_run", { automatic }),
  syncPause: (active: boolean) => call<SyncStatus>("sync_pause", { active }),
  syncDisconnect: () => call<SyncStatus>("sync_disconnect"),
  syncResolve: (id: string, choice: string) =>
    call<SyncStatus>("sync_resolve", { id, choice }),
  syncClaimHotp: (id: string, acknowledged: boolean) =>
    call<SyncStatus>("sync_claim_hotp", { id, acknowledged }),
  status: (): Promise<VaultStatus> =>
    native
      ? call<VaultStatus>("vault_status")
      : Promise.resolve({ initialized: false, locked: false, tokenCount: 0 }),
  quickCapabilities: () => call<QuickCapabilities>("quick_capabilities"),
  quickConfigure: (
    slot: "preview" | "biometric",
    enabled: boolean,
    password: string,
  ) => call<void>("quick_configure", { slot, enabled, password }),
  biometricUnlock: () => call<void>("quick_biometric_unlock"),
  previewEnter: () => call<void>("quick_preview_enter"),
  previewExit: () => call<void>("quick_preview_exit"),
  previewTokens: () => call<TokenView[]>("quick_preview_tokens"),
  create: (password: string) => call<void>("vault_create", { password }),
  unlock: (password: string) => call<void>("vault_unlock", { password }),
  touch: () => call<void>("vault_touch"),
  lock: () => call<void>("vault_lock"),
  background: (hidden: boolean) => call<void>("vault_background", { hidden }),
  tokenCodes: () => call<{ revision: string; codes: TokenCode[] }>("token_codes"),
  currentCode: (id: string) => call<Omit<TokenCode, "id">>("token_current_code", { id }),
  createToken: (input: ManualTokenInput) => call<string>("token_create", { input }),
  tokenBatch: (action: "group" | "pin" | "delete", ids: string[], options?: { group?: string; pinned?: boolean }) => call<number>("token_batch", { action, ids, ...options }),
  reorderTokens: (ids: string[]) => call<void>("token_reorder", { ids }),
  trash: () => call<TrashEntry[]>("trash_list"),
  trashRestore: (ids: string[]) => call<number>("trash_restore", { ids }),
  trashDelete: (ids: string[]) => call<number>("trash_delete", { ids }),
  changePassword: (currentPassword: string, newPassword: string) => call<void>("vault_change_password", { currentPassword, newPassword }),
  tokens: () =>
    native ? call<TokenView[]>("list_tokens") : Promise.resolve([]),
  preview: (args: {
    data?: number[];
    filename?: string;
    text?: string;
    password?: string;
  }) => call<ImportPreview>("import_preview", args),
  qrPreview: (payloads: string[]) =>
    call<QrImportProgress>("import_qr_preview", { payloads }),
  discardPreview: (previewId: string) =>
    call<void>("import_discard", { previewId }),
  importCameraSupported: () => call<boolean>("import_camera_supported"),
  commit: (previewId: string) => call<void>("import_commit", { previewId }),
  groups: () => call<string[]>("token_groups"),
  manageGroup: (
    action: "create" | "rename" | "delete",
    name: string,
    next?: string,
  ) => call<void>("token_group_manage", { action, name, next }),
  updateToken: (
    id: string,
    name: string,
    group: string | null,
    icon?: { value: string | null },
    parameters?: TokenParameters,
  ) => call<void>("token_update", { id, name, group, icon, parameters }),
  backupPreview: (name: string, password: string) => call<BackupPreview>("backup_preview", { name, password }),
  backupRestoreSelected: (previewId: string, ids: string[]) => call<number>("backup_restore_selected", { previewId, ids }),
  backupDirectory: (path?: string) => call<void>("backup_directory_configure", { path }),
  backupStatus: () => call<BackupStatus>("backup_status"),
  backupExternalStatus: () => call<ExternalBackupStatus>("backup_external_status"),
  backupExternalChoose: () => call<ExternalBackupStatus>("backup_external_choose"),
  backupExternalClear: () => call<ExternalBackupStatus>("backup_external_clear"),
  backupConfigure: (enabled: boolean) =>
    call<void>("backup_configure", { enabled }),
  backupNow: () => call<void>("backup_now"),
  backupExport: (name: string) =>
    call<string | null>("backup_export", { name }),
  backupRestore: (name: string, password: string) =>
    call<number>("backup_restore", { name, password }),
  rename: (id: string, name: string) =>
    call<void>("token_rename", { id, name }),
  remove: (id: string) => call<void>("token_delete", { id }),
  export: (password: string, format: "sgvault" | "mpo" = "sgvault") =>
    call<string | null>("vault_export", { password, format }),
  login: (id: string, username: string, password: string) =>
    call<LoginResult>("steam_login", { id, username, password }),
  guard: (id: string, code: string, codeType: number) =>
    call<LoginResult>("steam_submit_guard", { id, code, codeType }),
  guardLocal: (id: string) =>
    call<LoginResult>("steam_submit_local_guard", { id }),
  poll: (id: string) => call<LoginResult>("steam_poll_login", { id }),
  qrLogin: (id: string) => call<LoginResult>("steam_begin_qr", { id }),
  enroll: (id: string, name?: string) =>
    call<Enrollment>("steam_enroll_begin", { id, name }),
  activate: (id: string, smsCode: string) =>
    call<void>("steam_enroll_finalize", { id, smsCode }),
  transferBegin: (id: string) => call<void>("steam_transfer_begin", { id }),
  transferFinish: (id: string, smsCode: string, name?: string) =>
    call<Enrollment>("steam_transfer_finish", { id, smsCode, name }),
  removeGuard: (id: string, revocationCode: string) =>
    call<void>("steam_remove_authenticator", { id, revocationCode }),
  qrInfo: (id: string, url: string) =>
    call<Record<string, unknown>>("steam_qr_info", { id, url }),
  qrApprove: (id: string, url: string, approve: boolean) =>
    call<void>("steam_qr_approve", { id, url, approve }),
  uri: (id: string) => call<string>("token_uri", { id }),
  tokenExport: (id: string, format: "mafile" | "otpauth") =>
    call<string | null>("token_export", { id, format }),
  logout: (id: string) => call<void>("steam_logout", { id }),
  confirmations: (id: string) =>
    call<Confirmation[]>("steam_confirmations", { id }),
  confirm: (
    id: string,
    confirmationId: string,
    confirmationKey: string,
    approve: boolean,
  ) =>
    call<void>("steam_confirmation_action", {
      id,
      confirmationId,
      confirmationKey,
      approve,
    }),
  market: (id: string) => call<MarketResult>("steam_market", { id }),
  external: (url: string) => call<void>("open_external", { url }),
  syncTime: () => call<void>("sync_time"),
  networkSettings: () => call<NetworkSettings>("steam_network_settings"),
  configureNetwork: (settings: NetworkSettings) =>
    call<void>("steam_network_configure", { settings }),
  networkDiagnostics: () => call<NetworkReport>("steam_network_diagnostics"),
  nextHotp: (id: string) => call<void>("token_advance", { id }),
};
export { translateError as errorText } from "./i18n";
