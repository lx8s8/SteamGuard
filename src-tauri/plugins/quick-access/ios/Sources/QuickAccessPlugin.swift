import LocalAuthentication
import Security
import Tauri
import WebKit
import UIKit
import UniformTypeIdentifiers

private struct BackupPolicy: Decodable { let directory: String }
private struct AppearanceArgs: Decodable { let theme: String }
private struct SnapshotArgs: Decodable { let name: String; let data: String }
private struct AccessArgs: Decodable { let slot: String; let data: String?; let reason: String?; let fallback: String? }

final class QuickAccessPlugin: Plugin {
    private var backupPickerInvoke: Invoke?
    private let backupQueue = DispatchQueue(label: "com.kasen.steamguard.backup-io")
    private let service = "com.kasen.steamguard.quick-access.v1"
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
    @objc func appearance(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(AppearanceArgs.self)
        guard ["system", "light", "dark"].contains(args.theme) else { invoke.reject("主题无效"); return }
        DispatchQueue.main.async {
            guard let host = self.manager.viewController else { invoke.reject("无法设置主题"); return }
            host.overrideUserInterfaceStyle = args.theme == "dark" ? .dark : (args.theme == "light" ? .light : .unspecified)
            host.setNeedsStatusBarAppearanceUpdate()
            invoke.resolve()
        }
    }
    @objc func configureBackup(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(BackupPolicy.self)
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].standardizedFileURL
        var directory = URL(fileURLWithPath: args.directory, isDirectory: true).standardizedFileURL
        guard directory.path == support.path || directory.path.hasPrefix(support.path + "/") else {
            invoke.reject("备份目录不在应用存储区域"); return
        }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var included = URLResourceValues(); included.isExcludedFromBackup = false
        try directory.setResourceValues(included)
        var deviceOnly = directory.appendingPathComponent("device-only", isDirectory: true)
        try FileManager.default.createDirectory(at: deviceOnly, withIntermediateDirectories: true)
        var excluded = URLResourceValues(); excluded.isExcludedFromBackup = true
        try deviceOnly.setResourceValues(excluded)
        invoke.resolve()
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
        context.localizedReason = args.reason ?? "Unlock SteamGuard"
        context.localizedCancelTitle = args.fallback ?? "Use master password"
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

extension QuickAccessPlugin: UIDocumentPickerDelegate {
    private func bookmarkFile() throws -> URL {
        var directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("steamguard-device-only", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var excluded = URLResourceValues(); excluded.isExcludedFromBackup = true
        try directory.setResourceValues(excluded)
        return directory.appendingPathComponent("backup-folder.bookmark")
    }
    private func backupDestination() throws -> URL? {
        let file = try bookmarkFile()
        guard FileManager.default.fileExists(atPath: file.path) else { return nil }
        let data = try Data(contentsOf: file)
        var stale = false
        let url = try URL(resolvingBookmarkData: data, options: [], relativeTo: nil, bookmarkDataIsStale: &stale)
        if stale {
            let accessed = url.startAccessingSecurityScopedResource()
            defer { if accessed { url.stopAccessingSecurityScopedResource() } }
            let updated = try url.bookmarkData(options: .minimalBookmark, includingResourceValuesForKeys: nil, relativeTo: nil)
            try updated.write(to: file, options: .atomic)
        }
        return url
    }
    private func externalStatus() -> [String: Any] {
        do {
            let url = try backupDestination()
            return ["supported": true, "configured": url != nil,
                    "label": url?.lastPathComponent ?? "", "error": NSNull()]
        } catch {
            return ["supported": true, "configured": true, "label": "",
                    "error": "目录授权已失效，请重新选择备份目录"]
        }
    }
    private func withBackupFolder<T>(_ destination: URL, body: (URL) throws -> T) throws -> T {
        let accessed = destination.startAccessingSecurityScopedResource()
        defer { if accessed { destination.stopAccessingSecurityScopedResource() } }
        guard accessed || destination.path.hasPrefix(NSHomeDirectory() + "/") else { throw AccessError.invalid }
        let folder = destination.appendingPathComponent("SteamGuard Backups", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return try body(folder)
    }
    @objc func externalBackupStatus(_ invoke: Invoke) {
        backupQueue.async { invoke.resolve(self.externalStatus()) }
    }
    @objc func externalBackupChoose(_ invoke: Invoke) {
        DispatchQueue.main.async {
            guard self.backupPickerInvoke == nil, let host = self.manager.viewController else {
                invoke.reject("文件夹选择正在进行或不可用"); return
            }
            self.backupPickerInvoke = invoke
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder], asCopy: false)
            picker.allowsMultipleSelection = false
            picker.delegate = self
            host.present(picker, animated: true)
        }
    }
    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        guard let invoke = backupPickerInvoke else { return }
        backupPickerInvoke = nil
        backupQueue.async { invoke.resolve(self.externalStatus()) }
    }
    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let invoke = backupPickerInvoke else { return }
        backupPickerInvoke = nil
        guard let destination = urls.first else { invoke.resolve(externalStatus()); return }
        backupQueue.async {
            do {
                try self.withBackupFolder(destination) { folder in
                    let probe = folder.appendingPathComponent(".steamguard-check-" + UUID().uuidString)
                    try Data().write(to: probe, options: .atomic)
                    try FileManager.default.removeItem(at: probe)
                }
                let accessed = destination.startAccessingSecurityScopedResource()
                defer { if accessed { destination.stopAccessingSecurityScopedResource() } }
                let data = try destination.bookmarkData(options: .minimalBookmark, includingResourceValuesForKeys: nil, relativeTo: nil)
                try data.write(to: self.bookmarkFile(), options: .atomic)
                invoke.resolve(self.externalStatus())
            } catch { invoke.reject("目录授权或写入检查失败，请重新选择文件夹") }
        }
    }
    @objc func externalBackupClear(_ invoke: Invoke) {
        backupQueue.async {
            do {
                let file = try self.bookmarkFile()
                if FileManager.default.fileExists(atPath: file.path) { try FileManager.default.removeItem(at: file) }
                invoke.resolve(self.externalStatus())
            } catch { invoke.reject("无法重置外部备份目录") }
        }
    }
    @objc func externalBackupSnapshot(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(SnapshotArgs.self)
        backupQueue.async {
            do {
                guard let destination = try self.backupDestination() else { invoke.resolve(); return }
                let pattern = "^(recent|daily)-[0-9]{20}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.sgvault$"
                guard args.name.range(of: pattern, options: .regularExpression) != nil,
                    args.data.utf8.count <= 28 * 1024 * 1024,
                    let bytes = Data(base64Encoded: args.data), bytes.count <= 20 * 1024 * 1024,
                    let envelope = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
                    envelope["format"] as? String == "SteamGuard Vault", envelope["tokens"] == nil,
                    envelope["ciphertext"] is String else { throw AccessError.invalid }
                try self.withBackupFolder(destination) { folder in
                    let target = folder.appendingPathComponent(args.name)
                    if !FileManager.default.fileExists(atPath: target.path) {
                        var coordinatedError: NSError?
                        var writeError: Error?
                        NSFileCoordinator().coordinate(writingItemAt: folder, options: .forMerging, error: &coordinatedError) { coordinated in
                            do { try bytes.write(to: coordinated.appendingPathComponent(args.name), options: .atomic) }
                            catch { writeError = error }
                        }
                        if let error = coordinatedError { throw error }
                        if let error = writeError { throw error }
                    }
                    let files = try FileManager.default.contentsOfDirectory(at: folder,
                        includingPropertiesForKeys: [.contentModificationDateKey, .isRegularFileKey])
                        .filter { $0.lastPathComponent.range(of: pattern, options: .regularExpression) != nil }
                    for (prefix, limit) in [("recent-", 10), ("daily-", 30)] {
                        let rows = files.filter { $0.lastPathComponent.hasPrefix(prefix) }.sorted { a, b in
                            let at = String(a.lastPathComponent.dropFirst(prefix.count).prefix(20))
                            let bt = String(b.lastPathComponent.dropFirst(prefix.count).prefix(20))
                            if at != bt { return at > bt }
                            let ad = (try? a.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
                            let bd = (try? b.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
                            return ad > bd
                        }
                        for old in rows.dropFirst(limit) {
                            if try old.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true {
                                try FileManager.default.removeItem(at: old)
                            }
                        }
                    }
                }
                invoke.resolve()
            } catch { invoke.reject("外部备份写入失败，请检查目录授权和存储空间") }
        }
    }
}
@_cdecl("init_plugin_quick_access")
func initPlugin() -> Plugin { QuickAccessPlugin() }
