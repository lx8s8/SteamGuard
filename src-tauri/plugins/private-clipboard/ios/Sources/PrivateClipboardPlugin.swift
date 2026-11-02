import Foundation
import Tauri
import UIKit
private struct WriteArgs: Decodable { let text: String; let seconds: UInt64 }
private struct ClearArgs: Decodable { let owner: String }
final class PrivateClipboardPlugin: Plugin {
    @objc func write(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(WriteArgs.self)
        guard !args.text.isEmpty, args.text.utf8.count <= 32768, !args.text.contains("\0"), args.seconds <= 3600 else { invoke.reject("复制内容无效"); return }
        DispatchQueue.main.async {
            var options: [UIPasteboard.OptionsKey: Any] = [.localOnly: true]
            if args.seconds > 0 { options[.expirationDate] = Date().addingTimeInterval(Double(args.seconds)) }
            UIPasteboard.general.setItems([["public.utf8-plain-text": args.text]], options: options)
            invoke.resolve(["owner": String(UIPasteboard.general.changeCount)])
        }
    }
    @objc func clear(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(ClearArgs.self)
        DispatchQueue.main.async {
            guard let owner = Int(args.owner), UIPasteboard.general.changeCount == owner else { invoke.resolve(false); return }
            UIPasteboard.general.items = []
            invoke.resolve(true)
        }
    }
}
@_cdecl("init_plugin_private_clipboard")
func initPlugin() -> Plugin { PrivateClipboardPlugin() }
