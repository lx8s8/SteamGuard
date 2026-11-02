import Foundation
import GoogleSignIn
import Tauri
import UIKit

private struct GoogleArgs: Decodable {
    let clientId: String
    let expectedAccountId: String?
}
private struct CallbackArgs: Decodable { let url: String }

final class CloudAuthPlugin: Plugin {
    private var busy = false // main-queue confined
    private let scopes = ["https://www.googleapis.com/auth/drive.file"]
    private let unavailable = "Google 授权已取消或已失效，请重新连接同步网盘"
    private func configured(_ args: GoogleArgs) -> Bool {
        guard args.clientId.hasSuffix(".apps.googleusercontent.com"), args.clientId.count <= 256,
              args.clientId.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "." || $0 == "-") }) else { return false }
        let scheme = args.clientId.split(separator: ".").reversed().joined(separator: ".")
        let types = Bundle.main.object(forInfoDictionaryKey: "CFBundleURLTypes") as? [[String: Any]] ?? []
        return types.contains { ($0["CFBundleURLSchemes"] as? [String] ?? []).contains(scheme) }
    }
    @objc func availability(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(GoogleArgs.self)
        DispatchQueue.main.async { invoke.resolve(["available": self.configured(args)]) }
    }
    @objc func authorize(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(GoogleArgs.self)
        DispatchQueue.main.async {
            guard !self.busy else { invoke.reject("Google 登录正在进行，请稍候"); return }
            guard self.configured(args), let host = self.manager.viewController else {
                invoke.reject("此 iOS 构建尚未配置 Google 客户端和回调地址"); return
            }
            self.busy = true
            GIDSignIn.sharedInstance.configuration = GIDConfiguration(clientID: args.clientId)
            // Interactive reconnect lets the owner choose another account; it
            // never repurposes a silently restored account as a new connection.
            GIDSignIn.sharedInstance.signOut()
            GIDSignIn.sharedInstance.signIn(withPresenting: host, hint: nil, additionalScopes: self.scopes) { result, error in
                guard error == nil, let user = result?.user else { self.reject(invoke); return }
                self.complete(invoke, user, expected: nil)
            }
        }
    }
    @objc func token(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(GoogleArgs.self)
        DispatchQueue.main.async {
            guard !self.busy else { invoke.reject("Google 登录正在进行，请稍候"); return }
            guard self.configured(args), let expected = args.expectedAccountId, !expected.isEmpty else {
                invoke.reject(self.unavailable); return
            }
            self.busy = true
            GIDSignIn.sharedInstance.configuration = GIDConfiguration(clientID: args.clientId)
            if let user = GIDSignIn.sharedInstance.currentUser {
                self.complete(invoke, user, expected: expected)
            } else {
                // SDK owns its OS-protected session; the encrypted vault only
                // contains the expected account ID, never this refresh token.
                GIDSignIn.sharedInstance.restorePreviousSignIn { user, error in
                    guard error == nil, let user = user else { self.reject(invoke); return }
                    self.complete(invoke, user, expected: expected)
                }
            }
        }
    }
    private func reject(_ invoke: Invoke) {
        busy = false
        invoke.reject(unavailable)
    }
    private func complete(_ invoke: Invoke, _ user: GIDGoogleUser, expected: String?) {
        guard let account = user.userID, !account.isEmpty, account.count <= 256,
              expected == nil || account == expected,
              scopes.allSatisfy({ user.grantedScopes?.contains($0) == true }) else { reject(invoke); return }
        user.refreshTokensIfNeeded { refreshed, error in
            guard error == nil, let refreshed = refreshed, refreshed.userID == account,
                  !refreshed.accessToken.tokenString.isEmpty, refreshed.accessToken.tokenString.count <= 16384 else {
                self.reject(invoke); return
            }
            self.busy = false
            invoke.resolve(["accountId": account, "accessToken": refreshed.accessToken.tokenString])
        }
    }
    @objc func handleUrl(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(CallbackArgs.self)
        guard args.url.count <= 16384, let url = URL(string: args.url),
              let client = GIDSignIn.sharedInstance.configuration?.clientID,
              url.scheme == client.split(separator: ".").reversed().joined(separator: ".") else { invoke.resolve(); return }
        DispatchQueue.main.async {
            _ = GIDSignIn.sharedInstance.handle(url)
            invoke.resolve()
        }
    }
}
@_cdecl("init_plugin_cloud_auth")
func initPlugin() -> Plugin { CloudAuthPlugin() }
