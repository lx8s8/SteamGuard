# Steam integration

The native `src-tauri/src/steam.rs` implements Steam's mobile application protocol over HTTPS. Steam commands return status and display metadata without access tokens, refresh tokens, shared secrets, or identity secrets. The separate token-management flow intentionally reveals a token URI only after the user explicitly chooses to display its export QR code; maFile and text exports write through a native save dialog.

## Implemented behavior

- Password login obtains Valve's RSA public key, encrypts the password with RSA PKCS#1 v1.5, and starts a MobileApp authentication session.
- Existing challenges accept email or Steam Guard codes without restarting the challenge. Steam's requested polling interval is enforced and pending challenges expire after three minutes. Generation checks stop late results from replacing a newer challenge or reinstalling a logged-out session.
- QR login uses `BeginAuthSessionViaQR`. The URL is constrained to the exact HTTPS `s.team` host. A login cannot bind a different SteamID to an imported authenticator.
- A token code is submitted automatically only after the returned SteamID matches the authenticator's stored SteamID. An import without a SteamID requires an explicit verification code.
- Mobile access tokens renew using a MobileApp refresh token. Session restoration verifies account identity and mobile token purpose.
- Confirmations use server time and HMAC-SHA1 with the identity secret. Approve/reject requests must match a confirmation previously loaded for the same local token. A confirmation is consumed from the native cache before sending the request, so an uncertain network result requires refreshing the list to establish the actual remote result.
- Market listing and public market search responses are normalized into text, image URLs, and Steam market links. Remote HTML is never returned to the webview.
- A signed-in account can inspect a pasted Steam login QR URL before explicitly approving or rejecting it. Approval requires metadata for that same QR URL fetched within the previous two minutes and consumes that review once. The approval signature uses HMAC-SHA256 over little-endian version, challenge client ID, and SteamID.
- New authenticator enrollment, SMS activation, SMS transfer, and recovery-code removal use `ITwoFactorService` endpoints. Returned enrollment material is a native Rust type and must be saved in the encrypted vault before reporting success. Activation generates its authenticator code against the exact Steam server timestamp included in the request.

## Session persistence and network boundaries

`SteamService::export_session` and `restore_session` are exclusively for the encrypted native vault. `SteamSession` must never be used as a Tauri command response. Passwords are not saved. Local logout drops pending challenges, session credentials, and cached confirmations; it does not revoke every Steam session on the account.

The HTTP client disables redirects. Authentication requests go to `api.steampowered.com`; community requests with session cookies go to `steamcommunity.com`. Error messages omit request URLs, which may contain session credentials.

Account changes and transaction confirmations occur only after explicit user actions in the UI. Automated tests do not log in to Steam, enroll authenticators, transfer authenticators, remove authenticators, or approve/cancel real confirmations.

## Protocol references

- WattToolkit's `SteamTradePageViewModel`, `SteamAuthenticatorIdentity`, and related local authenticator flows in the reference repository.
- [Valve authentication protobuf definitions](https://github.com/SteamTracking/Protobufs/blob/master/steam/steammessages_auth.steamclient.proto).
- [Valve two-factor protobuf definitions](https://github.com/SteamTracking/Protobufs/blob/master/steam/steammessages_twofactor.steamclient.proto).
- [steam-session authentication transport](https://github.com/DoctorMcKay/node-steam-session/blob/master/src/transports/WebApiTransport.ts) and [QR approval](https://github.com/DoctorMcKay/node-steam-session/blob/master/src/LoginApprover.ts).
- [node-steamcommunity confirmation protocol](https://github.com/DoctorMcKay/node-steamcommunity/blob/master/components/confirmations.js).

Steam's mobile APIs are not a stable public application contract. Live login, account restrictions, SMS challenges, and market availability must be validated with a user-owned Steam account on each release. A successful local build or deterministic signature test does not establish that real Steam transactions were tested.

## Validation performed

Deterministic tests cover HMAC confirmation and QR signatures, account identity and token-purpose checks, current protobuf field wire types, URL encoding, and late challenge cancellation. An explicitly invoked read-only live probe obtained and decoded Steam's public RSA key for a synthetic account name; no password or login was submitted. This validates HTTPS and protobuf transport only. Real account login, enrollment, SMS transfer, removal, market eligibility, and transaction confirmations have not been exercised against a user account.
