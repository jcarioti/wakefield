import AppKit
import SwiftUI

@main
struct WakefieldMenuBarApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var model = WakefieldModel()

    var body: some Scene {
        MenuBarExtra {
            MenuPanel(model: model)
        } label: {
            Label("Wakefield", systemImage: model.menuBarSymbol)
        }
        .menuBarExtraStyle(.window)

        Settings {
            ControlWindow(model: model)
                .frame(minWidth: 760, minHeight: 560)
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
    }
}
