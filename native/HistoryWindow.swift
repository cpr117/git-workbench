import AppKit
import WebKit
import Darwin

// Walk the launch ancestry rather than guessing from a product name or whichever
// app happens to be frontmost after an asynchronous Git query finishes.
func owningApplication() -> NSRunningApplication? {
    var pid = getppid()
    var visited = Set<pid_t>()
    while pid > 1 && visited.insert(pid).inserted {
        if let app = NSRunningApplication(processIdentifier: pid), app.activationPolicy == .regular { return app }
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var query = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
        guard sysctl(&query, UInt32(query.count), &info, &size, nil, 0) == 0, size > 0 else { return nil }
        pid = info.kp_eproc.e_ppid
    }
    return nil
}

// This helper renders only the extension's local history UI. Git stays in the extension host.
final class HistoryPanel: NSPanel {
    override func cancelOperation(_ sender: Any?) { close() }
}

final class HistoryApp: NSObject, NSApplicationDelegate, NSWindowDelegate, WKScriptMessageHandler, WKNavigationDelegate {
    private var panel: HistoryPanel!
    private var webView: WKWebView!
    private var ownerApp: NSRunningApplication?
    private var workspaceObservers: [NSObjectProtocol] = []
    private var pageURL: URL!
    private var shown = false

    func emit(_ message: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: message) else { return }
        FileHandle.standardOutput.write(data + Data([10]))
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard CommandLine.arguments.count == 4 else { NSApp.terminate(nil); return }
        guard let owner = owningApplication() else {
            emit(["type": "fatal", "message": "无法识别启动历史窗口的应用，请从编辑器重新打开。"])
            NSApp.terminate(nil); return
        }
        ownerApp = owner
        let media = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true).resolvingSymlinksInPath().standardizedFileURL
        pageURL = media.appendingPathComponent("history-popup.html")
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.userContentController.add(self, name: "gitWorkbench")
        let theme = CommandLine.arguments[3] == "light" ? "light" : "dark"
        let script = "document.addEventListener('DOMContentLoaded', () => document.documentElement.dataset.theme = '\(theme)');"
        config.userContentController.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        let screen = NSScreen.main?.visibleFrame.size ?? NSSize(width: 1440, height: 900)
        let size = NSSize(width: min(960, screen.width * 0.82), height: min(600, screen.height * 0.82))
        panel = HistoryPanel(contentRect: NSRect(origin: .zero, size: size), styleMask: [.titled, .closable, .resizable, .utilityWindow], backing: .buffered, defer: false)
        panel.title = CommandLine.arguments[2]
        panel.minSize = NSSize(width: 740, height: 440)
        panel.isReleasedWhenClosed = false
        panel.isFloatingPanel = false
        panel.level = .normal
        // The helper and the editor are separate apps. AppKit's automatic hiding
        // would also hide the panel when clicking the editor itself.
        panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.fullScreenAuxiliary]
        panel.appearance = NSAppearance(named: theme == "light" ? .aqua : .darkAqua)
        panel.contentView = webView
        panel.delegate = self
        panel.center()
        let workspace = NSWorkspace.shared.notificationCenter
        for name in [NSWorkspace.didActivateApplicationNotification, NSWorkspace.didHideApplicationNotification] {
            workspaceObservers.append(workspace.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                self?.updateVisibility()
            })
        }
        workspaceObservers.append(workspace.addObserver(forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: .main) { [weak self] notification in
            guard let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
                  app.processIdentifier == self?.ownerApp?.processIdentifier else { return }
            NSApp.terminate(nil)
        })
        let menu = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        let close = appMenu.addItem(withTitle: "关闭历史窗口", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        close.target = panel
        appItem.submenu = appMenu
        menu.addItem(appItem)
        // Standard text shortcuts in WKWebView, including search and copying code.
        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "编辑")
        editMenu.addItem(withTitle: "复制", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu
        menu.addItem(editItem)
        NSApp.mainMenu = menu
        webView.loadFileURL(pageURL, allowingReadAccessTo: media)
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            while let line = readLine() {
                guard let data = line.data(using: .utf8), let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
                DispatchQueue.main.async { self?.receive(value) }
            }
            // The editor died or the extension was disabled. Never leave an orphan popup.
            DispatchQueue.main.async { self?.emit(["type": "hostClosing", "reason": "parentPipeClosed"]); NSApp.terminate(nil) }
        }
    }

    private func hidePanel() {
        panel.level = .normal
        panel.orderOut(nil)
    }

    private func updateVisibility(takeFocus: Bool = false) {
        guard shown, let owner = ownerApp, !owner.isTerminated, !owner.isHidden else { hidePanel(); return }
        let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
        guard front == owner.processIdentifier || front == ProcessInfo.processInfo.processIdentifier else { hidePanel(); return }
        // Raise only while the owning editor (or this panel) is active, and
        // preserve editor keyboard focus when returning from another app.
        // Float above all windows of the active editor. Leaving that editor
        // always resets the level before hiding, so this is not global pinning.
        panel.level = .floating
        panel.orderFrontRegardless()
        if takeFocus {
            panel.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        for observer in workspaceObservers { NSWorkspace.shared.notificationCenter.removeObserver(observer) }
        workspaceObservers.removeAll()
    }

    func receive(_ message: [String: Any]) {
        if message["type"] as? String == "closeHost" { panel.close(); return }
        webView.callAsyncJavaScript("window.dispatchEvent(new MessageEvent('message', {data: message}));", arguments: ["message": message], in: nil, in: .page) { [weak self] result in
            if case .failure = result { self?.emit(["type": "fatal", "message": "历史窗口无法接收数据。请关闭后重试。"]); NSApp.terminate(nil) }
        }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let value = message.body as? [String: Any] else { return }
        if value["type"] as? String == "rendered", !shown {
            shown = true
            updateVisibility(takeFocus: true)
        }
        emit(value)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        // No remote pages, external links, or arbitrary local files can replace this UI.
        decisionHandler(navigationAction.request.url?.standardizedFileURL == pageURL ? .allow : .cancel)
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        emit(["type": "fatal", "message": "历史窗口资源加载失败。"]); NSApp.terminate(nil)
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        emit(["type": "fatal", "message": "历史窗口渲染进程已退出，请重新打开。"]); NSApp.terminate(nil)
    }
    func windowWillClose(_ notification: Notification) {
        emit(["type": "hostClosing", "reason": "windowClosed"])
        if NSWorkspace.shared.frontmostApplication?.processIdentifier == ProcessInfo.processInfo.processIdentifier {
            ownerApp?.activate(options: [.activateIgnoringOtherApps])
        }
        NSApp.terminate(nil)
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = HistoryApp()
app.delegate = delegate
app.run()
