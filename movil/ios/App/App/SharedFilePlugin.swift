import Foundation
import Capacitor

// A GPX, TCX or FIT opened in DH Trails from another app (Files, WhatsApp, a watch's app): it waits here until
// a page takes it (the training page puts it in its file input). The same calls as on Android.
@objc(SharedFilePlugin)
public class SharedFilePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SharedFilePlugin"
    public let jsName = "SharedFile"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "peek", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "take", returnType: CAPPluginReturnPromise)
    ]
    private static let maxBytes = 20 * 1024 * 1024   // as the server takes
    // Set by the app delegate too, for a file that opens the app before the pages are loaded.
    static var pending: URL?

    override public func load() {
        NotificationCenter.default.addObserver(self, selector: #selector(opened(_:)), name: .capacitorOpenURL, object: nil)
    }

    // A file arrived while the app was open.
    @objc func opened(_ notification: Notification) {
        guard let info = notification.object as? [String: Any], let url = info["url"] as? URL, url.isFileURL else { return }
        SharedFilePlugin.pending = url
        notifyListeners("shared", data: [:], retainUntilConsumed: true)
    }

    @objc func peek(_ call: CAPPluginCall) {
        call.resolve(["pending": SharedFilePlugin.pending != nil])
    }

    // The file, once: its name and its bytes in base64.
    @objc func take(_ call: CAPPluginCall) {
        guard let url = SharedFilePlugin.pending else {
            call.resolve([:])
            return
        }
        SharedFilePlugin.pending = nil
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url), data.count <= SharedFilePlugin.maxBytes else {
            call.reject("unreadable")
            return
        }
        call.resolve(["name": url.lastPathComponent, "data": data.base64EncodedString()])
    }
}

// The app's view: Capacitor's, with the plugin above registered (it lives in the app, not in a package).
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(SharedFilePlugin())
        bridge?.registerPluginInstance(MotionRecorderPlugin())
    }
}
