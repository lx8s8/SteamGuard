export type Page = 'tokens' | 'confirmations' | 'market' | 'settings';
export type TokenKind = 'steam' | 'totp' | 'hotp';
export interface VaultStatus { initialized: boolean; locked: boolean; tokenCount: number }
export interface TokenView { id: string; name: string; issuer: string; kind: TokenKind; code: string; period: number; remaining: number; steamId?: string; accountName?: string; loggedIn?: boolean; algorithm?: string; digits?: number; counter?: number; hasIdentitySecret?: boolean; enrollmentPending?: boolean }
export interface ImportPreview { previewId: string; tokens: { name: string; issuer: string; kind: TokenKind }[]; duplicates: number }
export interface LoginResult { status: 'guard' | 'pending' | 'authenticated'; steamId?: string; username?: string; guards: { confirmationType: number; associatedMessage: string }[]; pollInterval: number; qrUrl?: string }
export interface Confirmation { id: string; nonce: string; kind: number; typeName: string; headline: string; summary: string[]; creationTime: number; icon: string }
export interface MarketItem { id: string; name: string; price?: string; quantity?: number; icon?: string; game?: string; url?: string }
export interface MarketResult { items: MarketItem[]; total?: number; walletBalance?: string; message?: string }

export interface Enrollment { id: string; phoneHint: string; revocationCode: string; needsActivation: boolean }
