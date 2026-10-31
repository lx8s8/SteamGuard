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

Account changes and transaction confirmations occur only after explicit user actions in the UI. Default and CI tests do not log in to Steam. A separately invoked account-owner probe reads account and password from a hidden interactive terminal, can use a matching private local authenticator for Guard validation, verifies the mobile session, and performs a read-only confirmation query. It does not persist credentials or tokens, change authenticators, or approve/cancel confirmations.

## Protocol references

- WattToolkit's `SteamTradePageViewModel`, `SteamAuthenticatorIdentity`, and related local authenticator flows in the reference repository.
- [Valve authentication protobuf definitions](https://github.com/SteamTracking/Protobufs/blob/master/steam/steammessages_auth.steamclient.proto).
- [Valve two-factor protobuf definitions](https://github.com/SteamTracking/Protobufs/blob/master/steam/steammessages_twofactor.steamclient.proto).
- [steam-session authentication transport](https://github.com/DoctorMcKay/node-steam-session/blob/master/src/transports/WebApiTransport.ts) and [QR approval](https://github.com/DoctorMcKay/node-steam-session/blob/master/src/LoginApprover.ts).
- [node-steamcommunity confirmation protocol](https://github.com/DoctorMcKay/node-steamcommunity/blob/master/components/confirmations.js).

Steam's mobile APIs are not a stable public application contract. Live login, account restrictions, SMS challenges, and market availability must be validated with a user-owned Steam account on each release. A successful local build or deterministic signature test does not establish that real Steam transactions were tested.

## Validation performed

Deterministic tests cover HMAC confirmation and QR signatures, account identity and token-purpose checks, current protobuf field wire types, URL encoding, and late challenge cancellation. An explicitly invoked read-only live probe obtained and decoded Steam's public RSA key for a synthetic account name; no password or login was submitted. This validates HTTPS and protobuf transport only. An explicitly authorized local account test subsequently completed password and matching Steam Guard authentication, verified a MobileApp session, and fetched the confirmation list read-only. No account name, password, SteamID, shared secret, access token, or refresh token is recorded in the repository or test output. Enrollment, SMS transfer, removal, market eligibility, and real approve/reject actions remain untested.

## Network changes in 0.1.1

The original project supplies a C# service; this application implements a separate native Rust transport. The live account test confirms the authentication exchange is functional; a generic connection error is not evidence that Valve removed the API or that the original project is broken. The protocol was compared with both [steam-session](https://github.com/DoctorMcKay/node-steam-session) and the maintained Rust [steamguard-cli WebAPI transport](https://github.com/dyc3/steamguard-cli/blob/master/steamguard/src/transport/webapi.rs).

Two actual defects in this implementation were addressed:

- A body-less `QueryTime` POST reproducibly returned HTTP 411. Supplying a nonempty `steamid=0` form fixes calibration and confirmation signing. The UI and confirmation service now share this request implementation.
- reqwest was built without default features and omitted `system-proxy`, which bypassed desktop system proxy discovery. That feature and SOCKS support are now explicit. Android additionally uses JNI to call `java.net.ProxySelector` for the destination origin. Steam session query parameters are never supplied to proxy selection. No guessed localhost port is used.

`network.rs` provides system, direct and manual modes. Preferences are saved in the encrypted vault; older vaults without preferences retain a system-mode default. Manual addresses reject embedded credentials and paths. TLS certificate checks and the no-redirect policy remain enabled. Network errors expose only a trusted operation label and a classified cause; a regression test verifies that session query parameters cannot appear in them.

The settings page and login error screen provide public-endpoint diagnostics. A user can save a manual proxy address when the proxy application only exposes a local port rather than updating OS settings. A successful diagnostic checks connectivity and response shape; it does not establish trading eligibility.

Optional owner-authorized test, launched from an interactive terminal:

```sh
WATT_TEST_MPO='/absolute/path/to/private.mpo' cargo test --manifest-path src-tauri/Cargo.toml --lib live_credentials_login_probe -- --ignored --nocapture
```

The terminal prompts for both values without echoing them. Do not put credentials in source, command arguments, environment files, CI variables or diagnostic reports. The backup path is optional; without a matching local authenticator the test stops when an additional Guard approval is needed.


## Login and Guard fixes in 1.0.1

Legacy SteamID `0`/empty values consistently mean unknown at import, challenge verification and persistence. A positive mismatched SteamID remains an error; unknown identities are persisted only after the local shared secret produces a Steam-accepted code. An authenticated session now records whether the local authenticator was verified, with a backwards-compatible default for existing saved sessions.

The previous error table incorrectly mapped EResult 88 to "two-factor required" and 85 to "expired code". The corrected meanings follow the [SteamKit protocol definitions](https://github.com/SteamRE/SteamKit/blob/master/Resources/SteamLanguage/eresult.steamd). Guard failures keep the current client/request IDs and allowed methods. Local codes are generated from Steam time after the initial network exchange. The UI provides direct local-code submission, manual/email input and phone approval when offered; polling does not reset a chosen method and is paused during submissions.

The owner-authorized live probe additionally exercises the native persistence/binding layer, using a temporary encrypted vault protected by a random password. Private temporary files are removed by a scope guard; no account identifiers, secrets or passwords are logged. This catches the prior distinction between successful network authentication and a failed local save.
