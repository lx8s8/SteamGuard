export type Page = "tokens" | "confirmations" | "market" | "settings";
export type TokenKind = "steam" | "totp" | "hotp";
export interface VaultStatus {
  initialized: boolean;
  locked: boolean;
  tokenCount: number;
  previewEnabled?: boolean;
  biometricEnabled?: boolean;
  previewActive?: boolean;
}
export interface TokenView {
  hotpReadOnly?: boolean;
  group?: string | null;
  id: string;
  name: string;
  issuer: string;
  kind: TokenKind;
  code: string;
  period: number;
  remaining: number;
  steamId?: string;
  accountName?: string;
  loggedIn?: boolean;
  algorithm?: string;
  digits?: number;
  counter?: number;
  hasIdentitySecret?: boolean;
  enrollmentPending?: boolean;
}
export interface ImportPreview {
  previewId: string;
  tokens: { name: string; issuer: string; kind: TokenKind }[];
  duplicates: number;
  groupCount?: number;
  canCommit?: boolean;
}
export interface LoginResult {
  status: "guard" | "pending" | "authenticated";
  steamId?: string;
  username?: string;
  guards: { confirmationType: number; associatedMessage: string }[];
  pollInterval: number;
  qrUrl?: string;
  message?: string;
  guardSubmitted?: boolean;
}
export interface Confirmation {
  id: string;
  nonce: string;
  kind: number;
  typeName: string;
  headline: string;
  summary: string[];
  creationTime: number;
  icon: string;
}
export interface MarketItem {
  id: string;
  name: string;
  price?: string;
  quantity?: number;
  icon?: string;
  game?: string;
  url?: string;
}
export interface MarketResult {
  items: MarketItem[];
  total?: number;
  walletBalance?: string;
  message?: string;
}

export interface Enrollment {
  id: string;
  phoneHint: string;
  revocationCode: string;
  needsActivation: boolean;
}

export interface NetworkSettings {
  mode: "system" | "direct" | "manual";
  proxyUrl: string;
}
export interface NetworkReport {
  platform: string;
  mode: NetworkSettings["mode"];
  checks: { name: string; ok: boolean; latencyMs: number; error?: string }[];
}

export interface QuickCapabilities {
  supported: boolean;
  biometricAvailable: boolean;
  label: string;
}

export interface BackupEntry {
  name: string;
  createdAt: number;
  size: number;
  daily: boolean;
}
export interface BackupStatus {
  enabled: boolean;
  entries: BackupEntry[];
  error: string | null;
  systemBackup: "ios-system" | "ios-unavailable" | "local";
}

export interface SyncStatus {
  configured: boolean;
  active: boolean;
  busy: boolean;
  endpoint: string;
  username: string;
  libraryId: string;
  dirty: boolean;
  lastSuccess: number;
  error?: string | null;
  conflicts: {
    id: string;
    name: string;
    field: string;
    choices: { id: string; label: string; local: boolean }[];
  }[];
}
export interface SyncCredentials {
  endpoint: string;
  username: string;
  password: string;
}
export interface SyncConnection extends SyncCredentials {
  syncPassword: string;
  mode: "create" | "join";
  libraryId?: string;
  confirmNewLibrary?: boolean;
}
