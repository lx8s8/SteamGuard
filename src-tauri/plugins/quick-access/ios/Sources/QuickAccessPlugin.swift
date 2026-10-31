import LocalAuthentication
import Security
import Tauri
import WebKit

private struct AccessArgs: Decodable { let slot: String; let data: String? }

final class QuickAccessPlugin: Plugin {
    private let service = "dev.local.steamguard.quick-access.v1"
    private func query(_ slot: String) throws -> [String: Any] {
        guard slot == "preview" || slot == "biometric" else { throw AccessError.invalid }
        return [kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service, kSecAttrAccount as String: slot,
                kSecAttrSynchronizable as String: false]
    }
    private enum AccessError: Error { case invalid }
    override func load(webview: WKWebView) {
        webview.scrollView.pinchGestureRecognizer?.isEnabled = false
        webview.scrollView.bouncesZoom = false
    }
    @objc func availability(_ invoke: Invoke) {
        let context = LAContext()
        let available = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
        invoke.resolve(["supported": true, "biometricAvailable": available,
                        "label": context.biometryType == .faceID ? "Face ID" : "Touch ID"])
    }
    @objc func write(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(AccessArgs.self)
        var item = try query(args.slot)
        guard let value = args.data?.data(using: .utf8), value.count <= 8192 else { invoke.reject("设备密钥无效"); return }
        if args.slot == "biometric" {
            guard LAContext().canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil),
                  let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, .biometryCurrentSet, nil)
            else { invoke.reject("请先设置 Face ID 或 Touch ID"); return }
            item[kSecAttrAccessControl as String] = access
        } else {
            item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        }
        item[kSecValueData as String] = value
        // The Rust caller disables the old enrollment before replacing it.
        SecItemDelete(try query(args.slot) as CFDictionary)
        let result = SecItemAdd(item as CFDictionary, nil)
        if result == errSecSuccess { invoke.resolve() }
        else { invoke.reject("无法保存本机密钥，请使用主密码（\(result)）") }
    }
    @objc func read(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(AccessArgs.self)
        var item = try query(args.slot)
        item[kSecReturnData as String] = true
        item[kSecMatchLimit as String] = kSecMatchLimitOne
        let context = LAContext()
        context.localizedReason = "验证后解锁 SteamGuard 本机保险库"
        context.localizedFallbackTitle = ""
        context.touchIDAuthenticationAllowableReuseDuration = 0
        item[kSecUseAuthenticationContext as String] = context
        DispatchQueue.global(qos: .userInitiated).async {
            var result: CFTypeRef?
            let status = SecItemCopyMatching(item as CFDictionary, &result)
            if status == errSecSuccess, let data = result as? Data, let value = String(data: data, encoding: .utf8) {
                invoke.resolve(["data": value])
            } else {
                invoke.reject("设备验证已取消或密钥不可用，请使用主密码（\(status)）")
            }
            context.invalidate()
        }
    }
    @objc func remove(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(AccessArgs.self)
        let result = SecItemDelete(try query(args.slot) as CFDictionary)
        if result == errSecSuccess || result == errSecItemNotFound { invoke.resolve() }
        else { invoke.reject("无法删除本机密钥（\(result)）") }
    }
}
@_cdecl("init_plugin_quick_access")
func initPlugin() -> Plugin { QuickAccessPlugin() }
