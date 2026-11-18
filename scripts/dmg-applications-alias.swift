import AppKit
import Foundation

let target = URL(fileURLWithPath: "/Applications", isDirectory: true)
let arguments = CommandLine.arguments.dropFirst()

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("\(message)\n".utf8))
    exit(EXIT_FAILURE)
}

guard (1...2).contains(arguments.count), let path = arguments.first else {
    fail("用法：dmg-applications-alias.swift <替身路径> [图标路径]")
}
let aliasURL = URL(fileURLWithPath: path)

do {
    if let iconPath = arguments.dropFirst().first {
        let bookmark = try target.bookmarkData(options: .suitableForBookmarkFile)
        try URL.writeBookmarkData(bookmark, to: aliasURL)
        guard let icon = NSImage(contentsOfFile: iconPath), NSWorkspace.shared.setIcon(icon, forFile: aliasURL.path) else {
            fail("无法为 Applications 替身设置停靠舱图标。")
        }
    }
    let values = try aliasURL.resourceValues(forKeys: [.isAliasFileKey])
    let destination = try URL(resolvingAliasFileAt: aliasURL, options: [.withoutUI, .withoutMounting])
    guard values.isAliasFile == true, destination.resolvingSymlinksInPath().path == target.resolvingSymlinksInPath().path else {
        fail("DMG 的 Applications 替身未指向应用程序文件夹。")
    }
    var finderInfo = [UInt8](repeating: 0, count: 32)
    let infoSize = getxattr(path, "com.apple.FinderInfo", &finderInfo, finderInfo.count, 0, XATTR_NOFOLLOW)
    let hasCustomIcon = infoSize == finderInfo.count && finderInfo[8] & 0x04 != 0
    let iconSize = getxattr(path, "com.apple.ResourceFork", nil, 0, 0, XATTR_NOFOLLOW)
    guard hasCustomIcon, iconSize > 0 else { fail("DMG 的 Applications 替身缺少停靠舱图标。") }
} catch {
    fail(error.localizedDescription)
}
