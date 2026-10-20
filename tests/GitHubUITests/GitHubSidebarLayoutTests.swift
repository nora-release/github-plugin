import AppKit
import SwiftUI
import Testing
@testable import GitHubCore
@testable import GitHubUI

@MainActor
struct GitHubSidebarLayoutTests {
    @Test func loadedAccountAvatarDoesNotBecomeTheNativeMenuImage() throws {
        let oversizedAvatar = NSImage(size: NSSize(width: 1024, height: 1024))
        let header = GitHubAccountHeader(login: "a-long-github-account-name") {
            Image(nsImage: oversizedAvatar).resizable().scaledToFill()
        } actions: { Button("Account action") {} }
        let host = NSHostingView(rootView: header)
        host.frame = NSRect(x: 0, y: 0, width: 268, height: 48)
        host.layoutSubtreeIfNeeded()
        #expect(abs(host.fittingSize.height - 48) < 1)
        let controls = descendants(of: host).compactMap { $0 as? NSControl }
        #expect(!controls.isEmpty)
        #expect(controls.allSatisfy { $0.frame.height <= 48 })
    }

    @Test func sidebarListBeginsNearItsControlsAndReportsItsActualSplitWidth() async throws {
        let service = GitHubService()
        service.user = .object(["id": .number(1), "login": .string("Layout Test")])
        service.items = [.object([
            "id": .number(2), "number": .number(1), "title": .string("A native issue"),
            "state": .string("open"), "repository": .object(["full_name": .string("layout/repository")]),
        ])]
        let host = NSHostingView(rootView: GitHubPanel(service: service))
        host.frame = NSRect(x: 0, y: 0, width: 1100, height: 760)
        host.layoutSubtreeIfNeeded()
        for _ in 0 ..< 8 {
            try await Task.sleep(for: .milliseconds(10))
            host.layoutSubtreeIfNeeded()
        }
        let split = try #require(descendants(of: host).compactMap { $0 as? NSSplitView }.first)
        let sidebar = try #require(split.arrangedSubviews.first)
        let list = try #require(descendants(of: sidebar).compactMap { $0 as? NSScrollView }.first)
        let listFrame = host.convert(list.bounds, from: list)
        #expect(listFrame.minY >= 150 && listFrame.minY < 240)
        #expect(abs(service.sidebarWidth - Double(sidebar.frame.width)) < 1)
        #expect(listFrame.height > host.frame.height / 2)
        let initialWidth = sidebar.frame.width
        split.setPosition(initialWidth > 260 ? 224 : 320, ofDividerAt: 0)
        for _ in 0 ..< 8 {
            try await Task.sleep(for: .milliseconds(10))
            host.layoutSubtreeIfNeeded()
        }
        #expect(abs(sidebar.frame.width - initialWidth) > 10)
        #expect(abs(service.sidebarWidth - Double(sidebar.frame.width)) < 1)
    }

    private func descendants(of view: NSView) -> [NSView] {
        view.subviews.flatMap { [$0] + descendants(of: $0) }
    }
}
